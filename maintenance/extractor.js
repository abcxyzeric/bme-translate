// ST-BME: LLM Ký ứcTrích xuấtPipeline（写入路径）
// 分析对话 → Trích xuấtnút和关系 → Cập nhậtđồ thị
// v2: 融合 Mem0 精确对照 + Graphiti 时序边 + MemoRAG Toàn cục概要

import { embedBatch } from "../vector/embedding.js";
import { debugLog, debugWarn } from "../runtime/debug-logging.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  findLatestNode,
  getActiveNodes,
  getNode,
  invalidateEdge,
  updateNode,
} from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import { ensureEventTitle } from "../graph/node-labels.js";
import {
  normalizeMemoryScope,
  isObjectiveScope,
} from "../graph/memory-scope.js";
import {
  applyCognitionUpdates,
  applyRegionUpdates,
  resolveKnowledgeOwner,
} from "../graph/knowledge-state.js";
import {
  applyBatchStoryTime,
  createSpanFromStoryTime,
  deriveStoryTimeSpanFromNodes,
  describeNodeStoryTime,
  normalizeStoryTime,
  resolveActiveStoryContext,
  upsertTimelineSegment,
} from "../graph/story-timeline.js";
import { getActiveSummaryEntries } from "../graph/summary-state.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { RELATION_TYPES } from "../graph/schema.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { getSTContextForPrompt, getSTContextSnapshot } from "../host/st-context.js";
import { buildExtractionInputContext } from "./extraction-context.js";
import { buildTaskGraphStats } from "./task-graph-stats.js";
import {
  aliasSetMatchesValue,
  buildUserPovAliasNormalizedSet,
  getHostUserAliasHints,
} from "../runtime/user-alias-utils.js";
import { buildNodeVectorText, isDirectVectorConfig } from "../vector/vector-index.js";

function createAbortError(message = "Thao tácĐã chấm dứt") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTaskLlmDebugContext(promptBuild, regexInput) {
  return typeof buildTaskExecutionDebugContext === "function"
    ? buildTaskExecutionDebugContext(promptBuild, { regexInput })
    : null;
}

function createExtractTaskLlmDebugContext(promptBuild, regexInput, inputContext = null) {
  const debugContext = createTaskLlmDebugContext(promptBuild, regexInput);
  if (!inputContext || typeof inputContext !== "object") {
    return debugContext;
  }
  return {
    ...debugContext,
    inputContext,
  };
}

function resolveTaskPromptPayload(promptBuild, fallbackUserPrompt = "") {
  if (typeof buildTaskLlmPayload === "function") {
    return buildTaskLlmPayload(promptBuild, fallbackUserPrompt);
  }

  return {
    systemPrompt: String(promptBuild?.systemPrompt || ""),
    userPrompt: String(fallbackUserPrompt || ""),
    promptMessages: [],
    additionalMessages: Array.isArray(promptBuild?.privateTaskMessages)
      ? promptBuild.privateTaskMessages
      : [],
  };
}

function resolveTaskLlmSystemPrompt(promptPayload, fallbackSystemPrompt = "") {
  const hasPromptMessages =
    Array.isArray(promptPayload?.promptMessages) &&
    promptPayload.promptMessages.length > 0;
  if (hasPromptMessages) {
    return String(promptPayload?.systemPrompt || "");
  }
  return String(promptPayload?.systemPrompt || fallbackSystemPrompt || "");
}

function buildActiveSummariesText(graph) {
  const entries = getActiveSummaryEntries(graph);
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries
    .map((entry, index) => {
      const rangeLabel = Array.isArray(entry.messageRange) && entry.messageRange.length >= 2
          && entry.messageRange[0] >= 0 && entry.messageRange[1] >= 0
        ? `楼${entry.messageRange[0]}~${entry.messageRange[1]}`
        : "";
      const levelLabel = entry.level ? `L${entry.level}` : "";
      const prefix = [rangeLabel, levelLabel].filter(Boolean).join(" ");
      return `[${index + 1}]${prefix ? ` (${prefix})` : ""} ${String(entry.text || entry.summary || "").trim()}`;
    })
    .filter((line) => line.trim())
    .join("\n");
}

function buildStoryTimeContextText(graph) {
  const storyCtx = resolveActiveStoryContext(graph);
  if (!storyCtx?.resolved) return "";
  const parts = [];
  if (storyCtx.activeStoryTimeLabel) {
    parts.push(`当前活跃剧情时间：${storyCtx.activeStoryTimeLabel}`);
  }
  if (storyCtx.source) {
    parts.push(`Nguồn：${storyCtx.source}`);
  }
  const seg = storyCtx.segment;
  if (seg?.tense && seg.tense !== "unknown") {
    parts.push(`时态：${seg.tense}`);
  }
  return parts.join(" | ");
}

function applyRecentMessageCap(messages, cap = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const numericCap = Number(cap);
  if (!Number.isFinite(numericCap) || numericCap <= 0) return messages;
  if (messages.length <= numericCap) return messages;
  return messages.slice(-numericCap);
}

function resolveExtractPromptStructuredMode(settings) {
  const mode = String(settings?.extractPromptStructuredMode || "both").trim().toLowerCase();
  if (["transcript", "structured", "both"].includes(mode)) return mode;
  return "both";
}

function formatExtractRankingMessage(message = {}) {
  const role = String(message?.role || "assistant").trim().toLowerCase() === "user"
    ? "user"
    : "assistant";
  const content = String(message?.content || "").trim();
  if (!content) return "";
  return `[${role}]: ${content}`;
}

function buildExtractRankingQueryText(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const targetLines = normalizedMessages
    .filter((message) => message?.isContextOnly !== true)
    .map((message) => formatExtractRankingMessage(message))
    .filter(Boolean);
  if (targetLines.length > 0) {
    return targetLines.join("\n");
  }
  return normalizedMessages
    .map((message) => formatExtractRankingMessage(message))
    .filter(Boolean)
    .join("\n");
}

function buildReflectionRankingQueryText({
  eventSummary = "",
  characterSummary = "",
  threadSummary = "",
  contradictionSummary = "",
} = {}) {
  return [
    eventSummary ? `Gần nhấtSự kiện:\n${eventSummary}` : "",
    characterSummary ? `近期Nhân vậtTrạng thái:\n${characterSummary}` : "",
    threadSummary ? `当前tuyến chính:\n${threadSummary}` : "",
    contradictionSummary ? `已知矛盾:\n${contradictionSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

const EXTRACTION_RESULT_CONTAINER_KEYS = [
  "operations",
  "nodes",
  "items",
  "entries",
  "memories",
  "results",
  "data",
  "memory_operations",
  "actions",
  "output",
  "extracted",
  "extractions",
  "memory_nodes",
];

const EXTRACTION_OPERATION_META_KEYS = new Set([
  "action",
  "op",
  "operation",
  "type",
  "fields",
  "nodeId",
  "node_id",
  "targetNodeId",
  "target_node_id",
  "sourceNodeId",
  "source_node_id",
  "ref",
  "reference",
  "id",
  "links",
  "relations",
  "edges",
  "importance",
  "clusters",
  "scope",
  "storyTime",
  "seq",
  "temporalStrength",
  "temporal_strength",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 判断一个đối tượng是否像一个 extraction Thao tác
 * (包含 action/op/operation/type 中的至少一个)
 */
function looksLikeSingleOperation(obj) {
  if (!isPlainObject(obj)) return false;
  return (
    typeof obj.action === "string" ||
    typeof obj.op === "string" ||
    typeof obj.operation === "string" ||
    typeof obj.type === "string"
  );
}

function extractOperationsPayload(result) {
  // 直接是数组 → 直接返回
  if (Array.isArray(result)) {
    return result;
  }
  if (!isPlainObject(result)) {
    return null;
  }

  // 1. 优先匹配已知容器键
  for (const key of EXTRACTION_RESULT_CONTAINER_KEYS) {
    if (Array.isArray(result[key])) {
      return result[key];
    }
  }

  // 2. 智能探测：扫描đối tượng中第一个值为非空数组且元素看起来像Thao tác的键
  for (const [key, value] of Object.entries(result)) {
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.some((item) => looksLikeSingleOperation(item))
    ) {
      debugLog(
        `[ST-BME] Tự động探测到非标准容器键: "${key}" (${value.length} 项)`,
      );
      return value;
    }
  }

  // 3. 单个Thao tácđối tượng兜底：如果整个Kết quả看起来像一条Thao tác，包装成数组
  if (looksLikeSingleOperation(result)) {
    debugLog(
      "[ST-BME] LLM 返回了单个Thao tácđối tượng，Tự động包装为数组",
    );
    return [result];
  }

  return null;
}

function resolveExtractionAction(rawOp) {
  const explicitAction = rawOp?.action ?? rawOp?.op ?? rawOp?.operation;
  if (typeof explicitAction === "string" && explicitAction.trim()) {
    return explicitAction.trim().toLowerCase();
  }

  if (rawOp?.type) {
    if (rawOp?.nodeId || rawOp?.node_id) {
      return "update";
    }
    return "create";
  }

  return "";
}

function resolveExtractionTypeDef(schema, type) {
  if (!Array.isArray(schema) || !type) {
    return null;
  }
  return schema.find((entry) => entry?.id === type) || null;
}

function resolveExtractionFieldNames(typeDef) {
  return new Set(
    Array.isArray(typeDef?.columns)
      ? typeDef.columns
          .map((column) => String(column?.name || "").trim())
          .filter(Boolean)
      : [],
  );
}

function resolveExtractionNodeId(rawOp) {
  const nodeId =
    rawOp?.nodeId ??
    rawOp?.node_id ??
    rawOp?.targetNodeId ??
    rawOp?.target_node_id ??
    rawOp?.id;
  return nodeId == null || nodeId === "" ? "" : String(nodeId);
}

function resolveExtractionRef(rawOp) {
  const ref = rawOp?.ref ?? rawOp?.reference ?? rawOp?.id;
  return ref == null || ref === "" ? "" : String(ref);
}

function collectNormalizedOperationFields(rawOp, typeDef) {
  const fieldNames = resolveExtractionFieldNames(typeDef);
  const fields = isPlainObject(rawOp?.fields) ? { ...rawOp.fields } : {};

  for (const [key, value] of Object.entries(rawOp || {})) {
    if (key === "fields") {
      continue;
    }

    if (key === "scope") {
      if (!isPlainObject(value) && (fieldNames.has("scope") || !typeDef)) {
        fields.scope = value;
      }
      continue;
    }

    if (EXTRACTION_OPERATION_META_KEYS.has(key)) {
      continue;
    }

    if (!typeDef || fieldNames.has(key)) {
      fields[key] = value;
    }
  }

  return fields;
}

function normalizeExtractionOperation(rawOp, schema) {
  if (!isPlainObject(rawOp)) {
    return rawOp;
  }

  const action = resolveExtractionAction(rawOp);
  const type = rawOp?.type == null ? "" : String(rawOp.type).trim();
  const typeDef = resolveExtractionTypeDef(schema, type);
  const normalized = {
    ...rawOp,
    ...(action ? { action } : {}),
    ...(type ? { type } : {}),
  };

  const nodeId = resolveExtractionNodeId(rawOp);
  const ref = resolveExtractionRef(rawOp);

  if (action === "create") {
    if (ref) {
      normalized.ref = ref;
    }
    delete normalized.nodeId;
  } else if ((action === "update" || action === "delete") && nodeId) {
    normalized.nodeId = nodeId;
  }

  if (Array.isArray(rawOp?.relations) && !Array.isArray(rawOp?.links)) {
    normalized.links = rawOp.relations;
  } else if (Array.isArray(rawOp?.edges) && !Array.isArray(rawOp?.links)) {
    normalized.links = rawOp.edges;
  }

  if (!Array.isArray(normalized.clusters) && normalized.clusters != null) {
    normalized.clusters = [normalized.clusters].filter(Boolean);
  }

  if (isPlainObject(rawOp?.scope)) {
    normalized.scope = rawOp.scope;
  } else if (action === "create" || action === "update") {
    delete normalized.scope;
  }

  if (isPlainObject(rawOp?.storyTime)) {
    normalized.storyTime = normalizeStoryTime(rawOp.storyTime, {
      source: "extract",
    });
  } else if (action === "create" || action === "update") {
    delete normalized.storyTime;
  }

  if (action === "create" || action === "update") {
    const fields = collectNormalizedOperationFields(rawOp, typeDef);
    if (Object.keys(fields).length > 0) {
      normalized.fields = fields;
    }
  }

  delete normalized.op;
  delete normalized.operation;
  delete normalized.node_id;
  delete normalized.target_node_id;
  delete normalized.source_node_id;
  delete normalized.reference;
  delete normalized.relations;
  delete normalized.edges;
  delete normalized.temporal_strength;

  return normalized;
}

function normalizeExtractionResultPayload(result, schema) {
  const operations = extractOperationsPayload(result);
  if (!Array.isArray(operations)) {
    return result;
  }

  const normalizedOperations = operations.map((op) =>
    normalizeExtractionOperation(op, schema),
  );
  const normalizedCognitionUpdates = Array.isArray(result?.cognitionUpdates)
    ? result.cognitionUpdates
        .filter(isPlainObject)
        .map((entry) => ({
          ownerType: String(entry?.ownerType || "").trim(),
          ownerName: String(entry?.ownerName || "").trim(),
          ownerId: String(entry?.ownerId || "").trim(),
          ownerNodeId: String(entry?.ownerNodeId || "").trim(),
          knownRefs: Array.isArray(entry?.knownRefs)
            ? entry.knownRefs
            : entry?.knownRefs != null
              ? [entry.knownRefs]
              : [],
          mistakenRefs: Array.isArray(entry?.mistakenRefs)
            ? entry.mistakenRefs
            : entry?.mistakenRefs != null
              ? [entry.mistakenRefs]
              : [],
          visibility: Array.isArray(entry?.visibility) ? entry.visibility : [],
        }))
    : [];
  const normalizedRegionUpdates = isPlainObject(result?.regionUpdates)
    ? {
        activeRegionHint: String(result.regionUpdates?.activeRegionHint || "").trim(),
        adjacency: Array.isArray(result.regionUpdates?.adjacency)
          ? result.regionUpdates.adjacency
              .filter(isPlainObject)
              .map((entry) => ({
                region: String(entry?.region || "").trim(),
                adjacent: Array.isArray(entry?.adjacent)
                  ? entry.adjacent
                  : entry?.adjacent != null
                    ? [entry.adjacent]
                    : [],
                source: String(entry?.source || "").trim(),
              }))
          : [],
      }
    : null;
  const normalizedBatchStoryTime = isPlainObject(result?.batchStoryTime)
    ? {
        ...normalizeStoryTime(result.batchStoryTime, { source: "extract" }),
        advancesActiveTimeline: result.batchStoryTime?.advancesActiveTimeline === true,
      }
    : null;

  if (Array.isArray(result) || !isPlainObject(result)) {
    return {
      operations: normalizedOperations,
      cognitionUpdates: normalizedCognitionUpdates,
      regionUpdates: normalizedRegionUpdates,
      batchStoryTime: normalizedBatchStoryTime,
    };
  }

  return {
    ...result,
    operations: normalizedOperations,
    cognitionUpdates: normalizedCognitionUpdates,
    regionUpdates: normalizedRegionUpdates,
    batchStoryTime: normalizedBatchStoryTime,
  };
}

function normalizeExtractionOwnerText(value) {
  return String(value || "").trim();
}

function collectExtractorUserAliasHints(scopeRuntime = {}, extraHints = []) {
  const hints = [];
  const pushHint = (value) => {
    const normalized = normalizeExtractionOwnerText(value);
    if (!normalized || hints.includes(normalized)) return;
    hints.push(normalized);
  };
  const ingest = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      pushHint(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) ingest(item);
      return;
    }
    if (typeof value === "object") {
      pushHint(value.name1);
      pushHint(value.userName);
      pushHint(value.personaName);
      pushHint(value.name);
      ingest(value.aliases);
    }
  };

  pushHint(scopeRuntime.activeUserOwner);
  ingest(getHostUserAliasHints(extraHints));
  return hints;
}

function buildExtractorUserAliasContext(scopeRuntime = {}, extraHints = []) {
  const aliasHints = collectExtractorUserAliasHints(scopeRuntime, extraHints);
  return {
    aliasHints,
    aliasSet: buildUserPovAliasNormalizedSet(aliasHints),
    preferredName: aliasHints[0] || "",
  };
}

function matchesExtractorUserAlias(ownerName = "", scopeRuntime = {}, extraHints = []) {
  const aliasContext = buildExtractorUserAliasContext(scopeRuntime, extraHints);
  return aliasSetMatchesValue(aliasContext.aliasSet, ownerName);
}

function resolveExtractorUserOwnerName(
  scopeRuntime = {},
  rawOwnerName = "",
  extraHints = [],
) {
  const aliasContext = buildExtractorUserAliasContext(scopeRuntime, [
    rawOwnerName,
    ...(Array.isArray(extraHints) ? extraHints : [extraHints]),
  ]);
  return aliasContext.preferredName || normalizeExtractionOwnerText(rawOwnerName);
}

function resolveCharacterOwnerCandidate(graph, ownerName = "", ownerNodeId = "") {
  const resolved = resolveKnowledgeOwner(graph, {
    ownerType: "character",
    ownerName,
    nodeId: ownerNodeId,
  });
  return resolved?.ownerType === "character" && resolved?.ownerKey ? resolved : null;
}

function deriveExtractionOwnerContext(
  graph,
  normalizedResult = {},
  scopeRuntime = {},
) {
  const ownerMap = new Map();
  const registerCharacterOwner = (ownerName = "", ownerNodeId = "", source = "") => {
    if (
      normalizeExtractionOwnerText(ownerName) &&
      !normalizeExtractionOwnerText(ownerNodeId) &&
      matchesExtractorUserAlias(ownerName, scopeRuntime)
    ) {
      return;
    }
    const resolved = resolveCharacterOwnerCandidate(graph, ownerName, ownerNodeId);
    if (!resolved?.ownerKey) return;
    const existing = ownerMap.get(resolved.ownerKey) || {
      ...resolved,
      sources: [],
    };
    if (source && !existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    ownerMap.set(resolved.ownerKey, existing);
  };

  for (const op of Array.isArray(normalizedResult?.operations)
    ? normalizedResult.operations
    : []) {
    if (String(op?.type || "") === "pov_memory") {
      registerCharacterOwner(
        op?.scope?.ownerName || op?.scope?.ownerId,
        "",
        "pov-memory-scope",
      );
    }
    if (
      String(op?.type || "") === "character" &&
      ["create", "update"].includes(String(op?.action || ""))
    ) {
      registerCharacterOwner(
        op?.fields?.name || "",
        String(op?.nodeId || ""),
        "character-operation",
      );
    }
  }

  for (const entry of Array.isArray(normalizedResult?.cognitionUpdates)
    ? normalizedResult.cognitionUpdates
    : []) {
    if (String(entry?.ownerType || "") !== "character") continue;
    registerCharacterOwner(
      entry?.ownerName || entry?.ownerId,
      entry?.ownerNodeId,
      "cognition-update",
    );
  }

  const runtimeOwner = resolveCharacterOwnerCandidate(
    graph,
    scopeRuntime.activeCharacterOwner,
    "",
  );
  if (runtimeOwner?.ownerKey && runtimeOwner?.nodeId && ownerMap.size <= 1) {
    registerCharacterOwner(runtimeOwner.ownerName, runtimeOwner.nodeId, "runtime-unique");
  }

  const ownerCandidates = [...ownerMap.values()];
  return {
    ownerCandidates,
    soleCharacterOwner: ownerCandidates.length === 1 ? ownerCandidates[0] : null,
  };
}

function normalizeCognitionUpdatesWithOwnerContext(
  graph,
  cognitionUpdates = [],
  scopeRuntime = {},
  ownerContext = {},
  ownershipWarnings = [],
) {
  const normalized = [];

  for (const entry of Array.isArray(cognitionUpdates) ? cognitionUpdates : []) {
    const ownerType = normalizeExtractionOwnerText(entry?.ownerType);
    const rawOwnerName = normalizeExtractionOwnerText(
      entry?.ownerName || entry?.ownerId,
    );
    const rawOwnerNodeId = normalizeExtractionOwnerText(entry?.ownerNodeId);
    if (ownerType === "character") {
      if (
        rawOwnerName &&
        !rawOwnerNodeId &&
        matchesExtractorUserAlias(rawOwnerName, scopeRuntime)
      ) {
        const resolvedUserName = resolveExtractorUserOwnerName(
          scopeRuntime,
          rawOwnerName,
        );
        if (!resolvedUserName) {
          ownershipWarnings.push({
            kind: "invalid-owner-scope",
            source: "cognitionUpdate",
            ownerType: "user",
          });
          continue;
        }
        normalized.push({
          ...entry,
          ownerType: "user",
          ownerName: resolvedUserName,
          ownerId: resolvedUserName,
          ownerNodeId: "",
        });
        continue;
      }
      const resolved =
        resolveCharacterOwnerCandidate(
          graph,
          rawOwnerName,
          rawOwnerNodeId,
        ) || ownerContext?.soleCharacterOwner || null;
      if (!resolved?.ownerKey) {
        ownershipWarnings.push({
          kind: "invalid-owner-scope",
          source: "cognitionUpdate",
          ownerType,
        });
        continue;
      }
      normalized.push({
        ...entry,
        ownerType: "character",
        ownerName: resolved.ownerName,
        ownerId: resolved.ownerName,
        ownerNodeId: resolved.nodeId || normalizeExtractionOwnerText(entry?.ownerNodeId),
      });
      continue;
    }

    if (ownerType === "user") {
      const resolvedUserName = resolveExtractorUserOwnerName(
        scopeRuntime,
        rawOwnerName,
      );
      if (!resolvedUserName) {
        ownershipWarnings.push({
          kind: "invalid-owner-scope",
          source: "cognitionUpdate",
          ownerType,
        });
        continue;
      }
      normalized.push({
        ...entry,
        ownerType: "user",
        ownerName: resolvedUserName,
        ownerId: resolvedUserName,
      });
      continue;
    }

    if (ownerContext?.soleCharacterOwner) {
      normalized.push({
        ...entry,
        ownerType: "character",
        ownerName: ownerContext.soleCharacterOwner.ownerName,
        ownerId: ownerContext.soleCharacterOwner.ownerName,
        ownerNodeId: ownerContext.soleCharacterOwner.nodeId || "",
      });
      continue;
    }

    ownershipWarnings.push({
      kind: "invalid-owner-scope",
      source: "cognitionUpdate",
      ownerType,
    });
  }

  return normalized;
}

function supportsPointStoryTime(type = "") {
  return ["event", "pov_memory"].includes(String(type || ""));
}

function supportsSpanStoryTime(type = "") {
  return ["thread", "synopsis", "reflection"].includes(String(type || ""));
}

function resolveOperationStoryTime(
  graph,
  op = {},
  batchStoryTime = null,
  { source = "extract" } = {},
) {
  const explicitStoryTime = normalizeStoryTime(op?.storyTime, { source });
  const fallbackStoryTime = normalizeStoryTime(batchStoryTime, { source });
  const candidate =
    explicitStoryTime.segmentId || explicitStoryTime.label
      ? explicitStoryTime
      : fallbackStoryTime.segmentId || fallbackStoryTime.label
        ? fallbackStoryTime
        : null;
  if (!candidate) {
    return {
      storyTime: normalizeStoryTime(),
      storyTimeSpan: createSpanFromStoryTime(null, source),
      timelineAdvanceApplied: false,
    };
  }

  const activeReferenceSegmentId = String(
    graph?.historyState?.activeStorySegmentId ||
      graph?.historyState?.lastExtractedStorySegmentId ||
      "",
  ).trim();
  const upserted = upsertTimelineSegment(graph, candidate, {
    referenceSegmentId: activeReferenceSegmentId,
    source,
  });
  return {
    storyTime: upserted.storyTime,
    storyTimeSpan: createSpanFromStoryTime(upserted.storyTime, source),
    timelineAdvanceApplied: false,
  };
}

function applyOperationStoryTimeToNode(
  graph,
  node,
  op = {},
  batchStoryTime = null,
  { source = "extract" } = {},
) {
  if (!node || typeof node !== "object") return;
  const resolved = resolveOperationStoryTime(graph, op, batchStoryTime, { source });
  if (supportsPointStoryTime(node.type)) {
    node.storyTime = resolved.storyTime;
    node.storyTimeSpan = createSpanFromStoryTime(null, source);
    return;
  }
  if (supportsSpanStoryTime(node.type)) {
    node.storyTime = normalizeStoryTime();
    node.storyTimeSpan = resolved.storyTimeSpan;
    return;
  }
  node.storyTime = normalizeStoryTime();
  node.storyTimeSpan = createSpanFromStoryTime(null, source);
}

/**
 * 对未Xử lý的对话tầng执行Ký ứcTrích xuất
 *
 * @param {object} params
 * @param {object} params.graph - 当前图Trạng thái
 * @param {Array<{seq?: number, role: string, content: string}>} params.messages - 要Xử lý的对话tin nhắn
 * @param {number} params.startSeq - 本批Xử lý的首个 assistant tin nhắn chat 索引
 * @param {number} params.endSeq - 本批Xử lý的末个 assistant tin nhắn chat 索引
 * @param {number} [params.lastProcessedSeq] - 上lầnXử lý到的 chat 索引
 * @param {object[]} params.schema - nútLoại Schema
 * @param {object} params.embeddingConfig - Embedding Cấu hình API
 * @param {string} [params.extractPrompt] - 自định nghĩaTrích xuất提示词
 * @param {object} [params.v2Options] - v2 增强选项
 * @returns {Promise<{success: boolean, newNodes: number, updatedNodes: number, newEdges: number, newNodeIds: string[], processedRange: [number, number]}>}
 */
export async function extractMemories({
  graph,
  messages,
  startSeq,
  endSeq,
  lastProcessedSeq = -1,
  schema,
  embeddingConfig,
  extractPrompt,
  signal = undefined,
  settings = {},
  onStreamProgress = null,
}) {
  throwIfAborted(signal);
  if (!messages || messages.length === 0) {
    return {
      success: true,
      newNodes: 0,
      updatedNodes: 0,
      newEdges: 0,
      newNodeIds: [],
      processedRange: [lastProcessedSeq, lastProcessedSeq],
    };
  }

  const effectiveStartSeq = Number.isFinite(startSeq)
    ? startSeq
    : (messages.find((m) => Number.isFinite(m.seq))?.seq ??
      lastProcessedSeq + 1);
  const effectiveEndSeq = Number.isFinite(endSeq)
    ? endSeq
    : ([...messages].reverse().find((m) => Number.isFinite(m.seq))?.seq ??
      effectiveStartSeq);
  const currentSeq = effectiveEndSeq;
  const stContext = getSTContextSnapshot();
  const scopeRuntime = {
    activeCharacterOwner: stContext?.prompt?.charName || "",
    activeUserOwner: stContext?.prompt?.userName || "",
  };

  debugLog(
    `[ST-BME] Trích xuất开始: chat[${effectiveStartSeq}..${effectiveEndSeq}], ${messages.length}  tin nhắn`,
  );

  const extractionInput = buildExtractionInputContext(messages, {
    settings,
    userName: stContext?.prompt?.userName || "",
    charName: stContext?.prompt?.charName || "",
  });
  const allStructuredMessages = Array.isArray(extractionInput?.filteredMessages)
    ? extractionInput.filteredMessages.map((message) => ({
        seq: message?.seq,
        role: message?.role,
        content: message?.content,
        speaker: message?.speaker,
        name: message?.name,
        hideSpeakerLabel: message?.hideSpeakerLabel === true,
        isContextOnly: message?.isContextOnly === true,
      }))
    : [];

  // Phase 3: apply recent message cap
  const structuredMessages = applyRecentMessageCap(
    allStructuredMessages,
    settings?.extractRecentMessageCap,
  );
  const cappedMessageCount = allStructuredMessages.length - structuredMessages.length;
  if (cappedMessageCount > 0) {
    debugLog(
      `[ST-BME][extract-p3] extractRecentMessageCap=${settings?.extractRecentMessageCap}, ` +
        `capped ${cappedMessageCount} messages (${allStructuredMessages.length} -> ${structuredMessages.length})`,
    );
  }

  // Phase 3: structured mode determines what goes into recentMessages/dialogueText
  const structuredMode = resolveExtractPromptStructuredMode(settings);
  const dialogueText = structuredMode === "structured"
    ? ""
    : String(extractionInput?.filteredTranscript || "");
  const promptRecentMessages = structuredMode === "transcript"
    ? dialogueText
    : structuredMessages;

  const extractGraphRankingQuery = buildExtractRankingQueryText(structuredMessages);
  const extractGraphStats = await buildTaskGraphStats({
    graph,
    schema,
    userMessage: extractGraphRankingQuery,
    recentMessages: [],
    embeddingConfig,
    signal,
    rankingOptions: {
      topK: 12,
      diffusionTopK: 48,
      enableContextQueryBlend: false,
      enableMultiIntent: true,
      maxTextLength: 1200,
    },
    relevantHeading: "与当前Trích xuất片段最相关的既有nút",
  });
  const extractGraphRanking = extractGraphStats.ranking;
  const extractGraphRelevantNodes = extractGraphStats.relevantReferenceMap;
  const graphOverview = extractGraphStats.graphStats;

  // 构建 Schema mô tả
  const schemaDescription = buildSchemaDescription(schema);
  const currentRange =
    messages.length > 0
      ? `${messages[0]?.seq ?? "?"} ~ ${messages[messages.length - 1]?.seq ?? "?"}`
      : "";

  // Phase 3: layered context — active summaries and story time
  const activeSummaries = settings?.extractIncludeSummaries !== false
    ? buildActiveSummariesText(graph)
    : "";
  const storyTimeContext = settings?.extractIncludeStoryTime !== false
    ? buildStoryTimeContextText(graph)
    : "";

  debugLog(
    `[ST-BME][extract-p3] structuredMode=${structuredMode}, ` +
      `activeSummaries=${activeSummaries ? activeSummaries.split("\n").length + " entries" : "none"}, ` +
      `storyTimeContext=${storyTimeContext ? "present" : "none"}, ` +
      `worldbookMode=${String(settings?.extractWorldbookMode || "active")}`,
  );
  if (extractGraphRanking) {
    debugLog(
      `[ST-BME][extract-graph] relevantNodes=${extractGraphRelevantNodes.references.length}, ` +
        `vectorMergedHits=${Number(extractGraphRanking?.diagnostics?.vectorMergedHits || 0)}, ` +
        `diffusionHits=${Number(extractGraphRanking?.diagnostics?.diffusionHits || 0)}, ` +
        `lexicalBoostedNodes=${Number(extractGraphRanking?.diagnostics?.lexicalBoostedNodes || 0)}`,
    );
  }

  const extractWorldbookMode = String(settings?.extractWorldbookMode || "active").trim().toLowerCase();
  const promptBuild = await buildTaskPrompt(settings, "extract", {
    taskName: "extract",
    schema: schemaDescription,
    schemaDescription,
    recentMessages: promptRecentMessages,
    chatMessages: structuredMessages,
    dialogueText,
    graphStats: graphOverview,
    graphOverview,
    currentRange,
    activeSummaries,
    storyTimeContext,
    taskInputDebug: extractionInput?.debug || null,
    __skipWorldInfo: extractWorldbookMode === "none",
    ...getSTContextForPrompt(),
  });

  // 系统提示词
  const extractRegexInput = { entries: [] };
  const systemPrompt = applyTaskRegex(
    settings,
    "extract",
    "finalPrompt",
    promptBuild.systemPrompt ||
      extractPrompt ||
      buildDefaultExtractPrompt(schema),
    extractRegexInput,
    "system",
  );

  // Người dùng提示词 — Phase 3 分层信息Cấu trúc
  const userPromptSections = [];

  // Layer 1: 当前对话切片（区分上下文回顾 vs Trích xuất目标）
  {
    const hasContextMessages = structuredMessages.some((m) => m?.isContextOnly === true);
    const hasTargetMessages = structuredMessages.some((m) => m?.isContextOnly !== true);
    if (dialogueText) {
      if (hasContextMessages && hasTargetMessages) {
        userPromptSections.push(
          "## 对话Nội dung",
          "以下对话包含两部分：已Trích xuất过的上下文回顾（仅供理解前情）和本lần需要Trích xuấtKý ức的新Nội dung。" +
            "请**只从新Nội dung中Trích xuấtKý ức**，不要重复Trích xuất上下文回顾中已有的信息。",
          dialogueText,
          "",
        );
      } else {
        userPromptSections.push("## 当前对话Nội dung（需Trích xuấtKý ức）", dialogueText, "");
      }
    } else if (structuredMode === "structured" && structuredMessages.length > 0) {
      if (hasContextMessages && hasTargetMessages) {
        userPromptSections.push(
          "## 对话Nội dung（Cấu trúc化tin nhắn）",
          "以下Cấu trúc化tin nhắn包含两部分：标记为 isContextOnly 的是已Trích xuất过的上下文回顾（仅供理解前情），" +
            "其余是本lần需要Trích xuấtKý ức的新Nội dung。请**只从 isContextOnly 为 false 的tin nhắn中Trích xuấtKý ức**。" +
            "(Cấu trúc化tin nhắn已通过 profile blocks Tiêm，请参考上方 recentMessages 块。)",
          "",
        );
      } else {
        userPromptSections.push(
          "## 当前对话Nội dung（Cấu trúc化tin nhắn，需Trích xuấtKý ức）",
          "(Cấu trúc化tin nhắn已通过 profile blocks Tiêm，请参考上方 recentMessages 块。)",
          "",
        );
      }
    }
  }

  // Layer 2: đồ thị hiện tạiTrạng thái
  userPromptSections.push(
    "## đồ thị hiện tạiTrạng thái",
    graphOverview || "(空đồ thị，尚Không có nút)",
    "",
  );

  // Layer 3: 已有总结snapshot（帮助避免重复Trích xuất）
  if (activeSummaries) {
    userPromptSections.push(
      "## 近期局面总结（已有覆盖，避免重复）",
      activeSummaries,
      "",
    );
  }

  // Layer 4: Thời gian cốt truyện线位置
  if (storyTimeContext) {
    userPromptSections.push(
      "## 当前Thời gian cốt truyện",
      storyTimeContext,
      "",
    );
  }

  // Layer 5: nútLoạiđịnh nghĩa
  userPromptSections.push("## nútLoạiđịnh nghĩa", schemaDescription, "");

  userPromptSections.push("请分析对话，按 JSON 格式输出Thao tác列表。");
  const userPrompt = userPromptSections.join("\n");
  const promptPayload = resolveTaskPromptPayload(promptBuild, userPrompt);
  const extractionAugmentPrompt = buildCognitiveExtractAugmentPrompt();
  const promptPayloadAdditionalMessages = Array.isArray(
    promptPayload.additionalMessages,
  )
    ? [
        ...promptPayload.additionalMessages,
        {
          role: "system",
          content: extractionAugmentPrompt,
        },
      ]
    : [
        {
          role: "system",
          content: extractionAugmentPrompt,
        },
      ];
  const llmSystemPrompt = resolveTaskLlmSystemPrompt(
    promptPayload,
    systemPrompt,
  );

  // 诊断：Theo dõi promptPayload
  {
    const pm = Array.isArray(promptPayload.promptMessages) ? promptPayload.promptMessages : [];
    const pmUser = pm.filter((m) => m?.role === "user");
    const am = Array.isArray(promptPayload.additionalMessages) ? promptPayload.additionalMessages : [];
    debugLog(
      `[ST-BME][prompt-diag] resolveTaskPromptPayload: ` +
        `promptMessages=${pm.length} (user=${pmUser.length}), ` +
        `additionalMessages=${am.length}, ` +
        `userPrompt length=${String(promptPayload.userPrompt || "").length}, ` +
        `systemPrompt length=${String(promptPayload.systemPrompt || "").length}, ` +
        `llmSystemPrompt length=${String(llmSystemPrompt || "").length}`,
    );
    if (pmUser.length > 0) {
      for (const m of pmUser) {
        debugLog(
          `[ST-BME][prompt-diag]   user msg: contentLen=${String(m.content || "").length}, ` +
            `blockName="${m.blockName || ""}", preview="${String(m.content || "").slice(0, 60)}..."`,
        );
      }
    } else {
      debugWarn(
        `[ST-BME][prompt-diag]   NO user messages in promptMessages! Fallback userPrompt will be used.`,
      );
    }
    if (extractionInput?.debug) {
      debugLog(
        `[ST-BME][extract-input] raw=${Number(extractionInput.debug.rawMessageCount || 0)}, ` +
          `filtered=${Number(extractionInput.debug.filteredMessageCount || 0)}, ` +
          `assistantChanged=${Number(extractionInput.debug.changedAssistantMessageCount || 0)}, ` +
          `assistantDropped=${Number(extractionInput.debug.droppedAssistantMessageCount || 0)}, ` +
          `extractRules=${Number(extractionInput.debug.assistantBoundaryConfig?.extractRuleCount || 0)}, ` +
          `excludeRules=${Number(extractionInput.debug.assistantBoundaryConfig?.excludeRuleCount || 0)}`,
      );
    }
  }

  // 调用 LLM
  const llmResult = await callLLMForJSON({
    systemPrompt: llmSystemPrompt,
    userPrompt: promptPayload.userPrompt,
    maxRetries: 2,
    signal,
    taskType: "extract",
    debugContext: createExtractTaskLlmDebugContext(
      promptBuild,
      extractRegexInput,
      extractionInput?.debug || null,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayloadAdditionalMessages,
    onStreamProgress,
    returnFailureDetails: true,
  });
  throwIfAborted(signal);
  const llmFailure =
    llmResult && typeof llmResult === "object" && "ok" in llmResult
      ? llmResult
      : null;
  const result = llmFailure
    ? llmFailure.ok
      ? llmFailure.data
      : null
    : llmResult;
  const normalizedResult = normalizeExtractionResultPayload(result, schema);
  const ownershipWarnings = [];
  const extractionOwnerContext = deriveExtractionOwnerContext(
    graph,
    normalizedResult,
    scopeRuntime,
  );
  const normalizedCognitionUpdates = normalizeCognitionUpdatesWithOwnerContext(
    graph,
    normalizedResult?.cognitionUpdates,
    scopeRuntime,
    extractionOwnerContext,
    ownershipWarnings,
  );

  if (!normalizedResult || !Array.isArray(normalizedResult.operations)) {
    const diagType = result === null
      ? "null"
      : Array.isArray(result)
        ? `array(len=${result.length})`
        : typeof result;
    const diagKeys = isPlainObject(result)
      ? Object.keys(result).slice(0, 10).join(", ")
      : "";
    const diagPreview = typeof result === "string"
      ? result.slice(0, 120)
      : "";
    console.warn(
      `[ST-BME] Trích xuất LLM 未返回有效Thao tác ` +
        `[type=${diagType}]` +
        (diagKeys ? ` [keys=${diagKeys}]` : "") +
        (diagPreview ? ` [preview=${diagPreview}]` : "") +
        (llmFailure?.ok === false && llmFailure?.errorType
          ? ` [failureType=${String(llmFailure.errorType)}]`
          : "") +
        (llmFailure?.ok === false && llmFailure?.failureReason
          ? ` [failureReason=${String(llmFailure.failureReason).slice(0, 200)}]`
          : ""),
    );
    const failureReason =
      llmFailure?.ok === false
        ? String(llmFailure.failureReason || "").trim()
        : "";
    return {
      success: false,
      error: failureReason
        ? `Trích xuất LLM 未返回有效Thao tác: ${failureReason}`
        : "Trích xuất LLM 未返回有效Thao tác",
      newNodes: 0,
      updatedNodes: 0,
      newEdges: 0,
      newNodeIds: [],
      processedRange: [lastProcessedSeq, lastProcessedSeq],
    };
  }

  // 执行Thao tác
  const stats = { newNodes: 0, updatedNodes: 0, newEdges: 0 };
  const newNodeIds = []; // v2: 收集新建nút ID（用于进化引擎）
  const updatedNodeIds = [];
  const refMap = new Map();
  const operationErrors = [];
  const normalizedBatchStoryTime = normalizedResult?.batchStoryTime || null;

  for (const op of normalizedResult.operations) {
    try {
      switch (op.action) {
        case "create": {
          const createdId = handleCreate(
            graph,
            op,
            currentSeq,
            schema,
            refMap,
            stats,
            scopeRuntime,
            extractionOwnerContext,
            ownershipWarnings,
            normalizedBatchStoryTime,
          );
          if (createdId) newNodeIds.push(createdId);
          break;
        }
        case "update":
          {
            const updatedNodeId = handleUpdate(
              graph,
              op,
              currentSeq,
              stats,
              scopeRuntime,
              extractionOwnerContext,
              ownershipWarnings,
              normalizedBatchStoryTime,
            );
            if (updatedNodeId) updatedNodeIds.push(updatedNodeId);
          }
          break;
        case "delete":
          handleDelete(graph, op, stats);
          break;
        case "_skip":
          // Mem0 对照判定为重复，Bỏ qua
          break;
        default: {
          const message = `[ST-BME] Thao tác không rõLoại: ${op?.action ?? "<missing>"}`;
          console.warn(message, op);
          operationErrors.push(message);
          break;
        }
      }
    } catch (e) {
      console.error(`[ST-BME] Thao tác执行Thất bại:`, op, e);
      operationErrors.push(e?.message || String(e));
    }
  }

  if (operationErrors.length > 0) {
    return {
      success: false,
      error: operationErrors.join(" | "),
      ...stats,
      newNodeIds,
      processedRange: [effectiveStartSeq, effectiveEndSeq],
    };
  }

  // 为新建nút生成 embedding。Thất bại不应回滚整批đồ thị写入。
  try {
    await generateNodeEmbeddings(graph, embeddingConfig, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.error("[ST-BME] nút embedding Sinh thất bại，保留đồ thị写入:", error);
  }

  // Cập nhậtXử lý进度：统一记录为已Xử lý到的末个 chat 索引
  graph.lastProcessedSeq = Math.max(
    graph.lastProcessedSeq ?? -1,
    effectiveEndSeq,
  );
  const changedNodeIds = [...new Set([...newNodeIds, ...updatedNodeIds])];
  if (ownershipWarnings.length > 0) {
    debugWarn(
      `[ST-BME] Đã bỏ qua ${ownershipWarnings.length} 条缺少具体人物 owner 的Ký ức chủ quan或认知Cập nhật`,
    );
  }
  applyCognitionUpdates(graph, normalizedCognitionUpdates, {
    refMap,
    changedNodeIds,
    scopeRuntime,
    source: "extract",
  });
  applyRegionUpdates(graph, normalizedResult.regionUpdates, {
    changedNodeIds,
    source: "extract",
  });
  const batchStoryTimeResult = applyBatchStoryTime(
    graph,
    normalizedBatchStoryTime,
    "extract",
  );
  updateRuntimeScopeState(graph, newNodeIds, scopeRuntime, extractionOwnerContext);

  debugLog(
    `[ST-BME] Trích xuấtHoàn tất: Tạo mới ${stats.newNodes}, Cập nhật ${stats.updatedNodes}, 新边 ${stats.newEdges}, lastProcessedSeq=${graph.lastProcessedSeq}`,
  );

  return {
    success: true,
    error: "",
    ...stats,
    newNodeIds,
    changedNodeIds,
    ownerWarnings: ownershipWarnings,
    batchStoryTime: normalizedBatchStoryTime,
    batchStoryTimeResult,
    processedRange: [effectiveStartSeq, effectiveEndSeq],
  };
}

/**
 * Xử lý create Thao tác
 */
function handleCreate(
  graph,
  op,
  seq,
  schema,
  refMap,
  stats,
  scopeRuntime = {},
  ownerContext = {},
  ownershipWarnings = [],
  batchStoryTime = null,
) {
  const normalizedFields =
    op.type === "event" ? ensureEventTitle(op.fields || {}) : op.fields || {};
  const typeDef = schema.find((s) => s.id === op.type);
  if (!typeDef) {
    console.warn(`[ST-BME] Không rõnútLoại: ${op.type}`);
    return null;
  }
  const scopeDecision = resolveOperationScope(
    graph,
    op,
    scopeRuntime,
    ownerContext,
  );
  if (scopeDecision.invalidReason) {
    ownershipWarnings.push({
      kind: scopeDecision.invalidReason,
      source: "operation",
      action: String(op?.action || ""),
      type: String(op?.type || ""),
    });
    return null;
  }
  const nodeScope = scopeDecision.scope;

  // latestOnly Loại：检查是否已存在同名nút
  if (typeDef.latestOnly && op.fields?.name) {
    const existing = findLatestNode(
      graph,
      op.type,
      op.fields.name,
      "name",
      nodeScope,
    );
    if (existing) {
      // 转为Cập nhậtThao tác
      updateNode(graph, existing.id, { fields: op.fields, seq, scope: nodeScope });
      applyOperationStoryTimeToNode(graph, existing, op, batchStoryTime);
      stats.updatedNodes++;

      if (op.ref) refMap.set(op.ref, existing.id);

      // Xử lýLiên kết边
      if (op.links) {
        handleLinks(graph, existing.id, op.links, refMap, stats);
      }
      return null;
    }
  }

  // 创建新nút
  const node = createNode({
    type: op.type,
    fields: normalizedFields,
    seq,
    importance: op.importance ?? 5.0,
    clusters: op.clusters || [],
    scope: nodeScope,
  });
  applyOperationStoryTimeToNode(graph, node, op, batchStoryTime);

  addNode(graph, node);
  stats.newNodes++;

  // Lưu ref 用于同批lần引用
  if (op.ref) {
    refMap.set(op.ref, node.id);
  }

  // Xử lýLiên kết边
  if (op.links) {
    handleLinks(graph, node.id, op.links, refMap, stats);
  }

  return node.id;
}

/**
 * Xử lý update Thao tác
 */
function handleUpdate(
  graph,
  op,
  currentSeq,
  stats,
  scopeRuntime = {},
  ownerContext = {},
  ownershipWarnings = [],
  batchStoryTime = null,
) {
  if (!op.nodeId) {
    console.warn("[ST-BME] update Thao tác缺少 nodeId");
    return "";
  }

  const previousNode = getNode(graph, op.nodeId);
  if (!previousNode) {
    console.warn(`[ST-BME] update 目标nút不存在: ${op.nodeId}`);
    return "";
  }

  const previousFields = { ...(previousNode.fields || {}) };
  const nextFields =
    previousNode.type === "event"
      ? ensureEventTitle({ ...previousFields, ...(op.fields || {}) })
      : { ...previousFields, ...(op.fields || {}) };
  const changeSummary = buildFieldChangeSummary(previousFields, nextFields);
  const scopeDecision = resolveOperationScope(
    graph,
    op,
    scopeRuntime,
    ownerContext,
    { existingScope: previousNode.scope },
  );
  if (scopeDecision.invalidReason && previousNode.type === "pov_memory") {
    ownershipWarnings.push({
      kind: scopeDecision.invalidReason,
      source: "operation",
      action: String(op?.action || ""),
      type: String(op?.type || ""),
      nodeId: previousNode.id,
    });
  }
  const resolvedScope = scopeDecision.scope;

  const updateSeq = Number.isFinite(op.seq) ? op.seq : currentSeq;
  const updated = updateNode(graph, op.nodeId, {
    fields: op.fields || {},
    seq: Math.max(previousNode.seq || 0, updateSeq),
    scope: resolvedScope,
  });

  if (updated) {
    stats.updatedNodes++;
    const node = getNode(graph, op.nodeId);
    if (node) {
      applyOperationStoryTimeToNode(graph, node, op, batchStoryTime);
      node.embedding = null;
      node.seq = Math.max(node.seq || 0, updateSeq);
      node.seqRange = [
        Math.min(node.seqRange?.[0] ?? node.seq, updateSeq),
        Math.max(node.seqRange?.[1] ?? node.seq, updateSeq),
      ];
    }

    // v2 Graphiti: 标记旧的 updates/temporal_update 边为失效
    const oldEdges = graph.edges.filter(
      (e) =>
        !e.invalidAt &&
        ((e.relation === "updates" && e.toId === op.nodeId) ||
          (e.relation === "temporal_update" &&
            e.toId === op.nodeId &&
            op.sourceNodeId &&
            e.fromId === op.sourceNodeId)),
    );
    for (const e of oldEdges) {
      invalidateEdge(e);
    }

    if (op.sourceNodeId && op.sourceNodeId !== op.nodeId) {
      const temporalEdge = createEdge({
        fromId: op.sourceNodeId,
        toId: op.nodeId,
        relation: "temporal_update",
        strength: op.temporalStrength ?? 0.95,
        edgeType: 0,
      });
      if (addEdge(graph, temporalEdge)) {
        stats.newEdges++;
      }
    }

    if (changeSummary) {
      const updateEventNode = createNode({
        type: "event",
        fields: {
          title: `${previousNode.fields?.name || previousNode.fields?.title || previousNode.type} Trạng tháiCập nhật`,
          summary: `${previousNode.type} Trạng tháiCập nhật：${changeSummary}`,
          participants:
            previousNode.fields?.name ||
            previousNode.fields?.title ||
            previousNode.id,
          status: "resolved",
        },
        seq: updateSeq,
        importance: Math.max(
          4,
          Math.min(8, op.importance ?? previousNode.importance ?? 5),
        ),
        scope: isObjectiveScope(previousNode.scope)
          ? normalizeMemoryScope(previousNode.scope)
          : normalizeMemoryScope({
              layer: "objective",
              regionPrimary: resolvedScope.regionPrimary,
              regionPath: resolvedScope.regionPath,
              regionSecondary: resolvedScope.regionSecondary,
            }),
      });
      addNode(graph, updateEventNode);
      stats.newNodes++;

      const updateEdge = createEdge({
        fromId: updateEventNode.id,
        toId: op.nodeId,
        relation: "updates",
        strength: 0.9,
        edgeType: 0,
        scope: updateEventNode.scope,
      });
      if (addEdge(graph, updateEdge)) {
        stats.newEdges++;
      }
    }
  }
  return updated ? op.nodeId : "";
}

function buildFieldChangeSummary(previousFields = {}, nextFields = {}) {
  const changes = [];
  const keys = new Set([
    ...Object.keys(previousFields),
    ...Object.keys(nextFields),
  ]);

  for (const key of keys) {
    const before = previousFields[key];
    const after = nextFields[key];
    if (before === after) continue;

    const beforeText = before == null || before === "" ? "空" : String(before);
    const afterText = after == null || after === "" ? "空" : String(after);
    changes.push(`${key}: ${beforeText} -> ${afterText}`);
  }

  return changes.slice(0, 3).join("；");
}

/**
 * Xử lý delete Thao tác
 */
function handleDelete(graph, op, stats) {
  if (!op.nodeId) return;
  const node = graph.nodes.find((n) => n.id === op.nodeId);
  if (node) {
    node.archived = true; // 软Xóa
  }
}

/**
 * Xử lýLiên kết边
 */
function handleLinks(graph, sourceId, links, refMap, stats) {
  const sourceNode = getNode(graph, sourceId);
  const sourceScope = normalizeMemoryScope(sourceNode?.scope);
  for (const link of links) {
    let targetId = link.targetNodeId || null;

    // 通过 ref 解析目标nút
    if (!targetId && link.targetRef) {
      targetId = refMap.get(link.targetRef);
    }

    if (!targetId) continue;

    // 验证关系Loại
    const relation = RELATION_TYPES.includes(link.relation)
      ? link.relation
      : "related";

    const edgeType = relation === "contradicts" ? 255 : 0;

    const edge = createEdge({
      fromId: sourceId,
      toId: targetId,
      relation,
      strength: link.strength ?? 0.8,
      edgeType,
      scope: link.scope || sourceScope,
    });

    if (addEdge(graph, edge)) {
      stats.newEdges++;
    }
  }
}

function resolveOperationScope(
  graph,
  op,
  scopeRuntime = {},
  ownerContext = {},
  { existingScope = null } = {},
) {
  const fallbackScope = normalizeMemoryScope(
    existingScope || { layer: op?.type === "pov_memory" ? "pov" : "objective" },
  );

  if (op?.type !== "pov_memory") {
    return {
      scope: op?.scope
        ? normalizeMemoryScope(op.scope, existingScope || {})
        : fallbackScope.layer === "objective"
          ? fallbackScope
          : normalizeMemoryScope({ layer: "objective" }),
      invalidReason: "",
    };
  }

  if (!op?.scope && existingScope) {
    return {
      scope: normalizeMemoryScope(existingScope),
      invalidReason: "",
    };
  }

  const rawScope = op?.scope ? normalizeMemoryScope(op.scope) : null;
  const ownerType = String(rawScope?.ownerType || "").trim();
  const explicitOwnerName = normalizeExtractionOwnerText(
    rawScope?.ownerName || rawScope?.ownerId,
  );
  const explicitOwnerNodeId = normalizeExtractionOwnerText(
    op?.scope?.ownerNodeId || op?.scope?.owner_node_id,
  );

  if (ownerType === "user") {
    const userName = resolveExtractorUserOwnerName(
      scopeRuntime,
      explicitOwnerName,
    );
    if (!userName) {
      return {
        scope: fallbackScope,
        invalidReason: "invalid-owner-scope",
      };
    }
    return {
      scope: normalizeMemoryScope({
        ...(rawScope || {}),
        layer: "pov",
        ownerType: "user",
        ownerId: userName,
        ownerName: userName,
      }),
      invalidReason: "",
    };
  }

  if (
    ownerType === "character" &&
    explicitOwnerName &&
    !explicitOwnerNodeId &&
    matchesExtractorUserAlias(explicitOwnerName, scopeRuntime)
  ) {
    const userName = resolveExtractorUserOwnerName(
      scopeRuntime,
      explicitOwnerName,
    );
    if (!userName) {
      return {
        scope: fallbackScope,
        invalidReason: "invalid-owner-scope",
      };
    }
    return {
      scope: normalizeMemoryScope({
        ...(rawScope || {}),
        layer: "pov",
        ownerType: "user",
        ownerId: userName,
        ownerName: userName,
      }),
      invalidReason: "",
    };
  }

  const resolvedCharacterOwner =
    resolveCharacterOwnerCandidate(graph, explicitOwnerName, explicitOwnerNodeId) ||
    ownerContext?.soleCharacterOwner ||
    null;
  if (!resolvedCharacterOwner?.ownerKey) {
    return {
      scope: fallbackScope,
      invalidReason: "invalid-owner-scope",
    };
  }

  return {
    scope: normalizeMemoryScope({
      ...(rawScope || {}),
      layer: "pov",
      ownerType: "character",
      ownerId: resolvedCharacterOwner.ownerName,
      ownerName: resolvedCharacterOwner.ownerName,
    }),
    invalidReason: "",
  };
}

function updateRuntimeScopeState(
  graph,
  newNodeIds = [],
  scopeRuntime = {},
  ownerContext = {},
) {
  if (!graph?.historyState || typeof graph.historyState !== "object") {
    return;
  }

  graph.historyState.activeCharacterPovOwner =
    String(ownerContext?.soleCharacterOwner?.ownerName || "");
  graph.historyState.activeUserPovOwner =
    String(scopeRuntime.activeUserOwner || "");

  const objectiveCandidates = (Array.isArray(newNodeIds) ? newNodeIds : [])
    .map((nodeId) => getNode(graph, nodeId))
    .filter((node) => node && !node.archived && isObjectiveScope(node.scope))
    .sort((a, b) => (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0));

  const regionNode =
    objectiveCandidates.find((node) => node.scope?.regionPrimary) ||
    getActiveNodes(graph)
      .filter((node) => !node.archived && isObjectiveScope(node.scope))
      .sort((a, b) => (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0))
      .find((node) => node.scope?.regionPrimary);

  if (regionNode?.scope?.regionPrimary) {
    graph.historyState.lastExtractedRegion = String(
      regionNode.scope.regionPrimary || "",
    );
    if (!String(graph?.regionState?.manualActiveRegion || "").trim()) {
      graph.historyState.activeRegion = String(regionNode.scope.regionPrimary || "");
      graph.historyState.activeRegionSource = "extract";
    }
  }
}

/**
 * 为缺少 embedding 的nút生成Vector
 */
async function generateNodeEmbeddings(graph, embeddingConfig, signal) {
  if (!isDirectVectorConfig(embeddingConfig)) return;
  throwIfAborted(signal);

  const needsEmbedding = graph.nodes.filter(
    (n) =>
      !n.archived && (!Array.isArray(n.embedding) || n.embedding.length === 0),
  );

  if (needsEmbedding.length === 0) return;

  const texts = needsEmbedding.map(
    (node) => buildNodeVectorText(node) || node.type,
  );

  debugLog(`[ST-BME] 为 ${texts.length}  nút生成 embedding`);

  const embeddings = await embedBatch(texts, embeddingConfig, { signal });

  for (let i = 0; i < needsEmbedding.length; i++) {
    if (embeddings[i]) {
      needsEmbedding[i].embedding = Array.from(embeddings[i]);
    }
  }
}

/**
 * 构建 Schema mô tả文本
 */
function buildSchemaDescription(schema) {
  return schema
    .map((t) => {
      const cols = t.columns
        .map((c) => `${c.name}${c.required ? "(必填)" : ""}: ${c.hint}`)
        .join("\n    ");
      return `Loại "${t.id}" (${t.label}):\n    ${cols}`;
    })
    .join("\n\n");
}

/**
 * 构建Mặc địnhTrích xuất提示词
 */
function buildDefaultExtractPrompt(schema) {
  const typeNames = schema.map((s) => `${s.id}(${s.label})`).join(", ");

  return [
    "你是一个Ký ứcTrích xuất分析器。从对话中Trích xuấtCấu trúc化Ký ứcnút并存入知识đồ thị。",
    "",
    `支持的nútLoại：${typeNames}`,
    "",
    "这轮必须同时考虑三层信息：",
    "- Khách quan事实：继续写入 event / character / location / thread / rule / synopsis / reflection",
    '- Ký ức chủ quan：统一写入 pov_memory，使用 scope.layer = "pov"',
    "- 地区归属：能判断时写入 scope.regionPrimary / regionPath / regionSecondary，判断不出来就留空",
    "",
    "Định dạng đầu ra为严格 JSON：",
    "{",
    '  "thought": "你对本段对话的分析（Sự kiện/Nhân vật变化/新信息/谁如何理解）",',
    '  "batchStoryTime": {"label": "Sáng sớm ngày thứ hai", "tense": "ongoing", "relation": "after", "anchorLabel": "Sau xung đột đêm qua", "confidence": "high", "advancesActiveTimeline": true},',
    '  "operations": [',
    "    {",
      '      "action": "create",',
      '      "type": "event",',
      '      "fields": {"title": "Tên sự kiện ngắn", "summary": "...", "participants": "...", "status": "ongoing"},',
      '      "scope": {"layer": "objective", "regionPrimary": "Khu vực chính", "regionPath": ["Khu vực cấp trên", "Khu vực chính"], "regionSecondary": ["Khu vực cấp phụ"]},',
      '      "storyTime": {"label": "Sáng sớm ngày thứ hai", "tense": "ongoing", "relation": "same", "confidence": "high"},',
      '      "importance": 6,',
      '      "ref": "evt1",',
    '      "links": [',
    '        {"targetNodeId": "existing-id", "relation": "involved_in", "strength": 0.9},',
    '        {"targetRef": "char1", "relation": "occurred_at", "strength": 0.8}',
    "      ]",
    "    },",
    "    {",
    '      "action": "create",',
    '      "type": "pov_memory",',
    '      "fields": {"summary": "Nhân vật怎么记住这件事", "belief": "Cô ấy cho rằng đã xảy ra chuyện gì", "emotion": "Cảm xúc", "attitude": "Thái độ", "certainty": "unsure", "about": "evt1"},',
    '      "scope": {"layer": "pov", "ownerType": "character", "ownerId": "Tên nhân vật", "ownerName": "Tên nhân vật", "regionPrimary": "Khu vực chính", "regionPath": ["Khu vực cấp trên", "Khu vực chính"]}',
    "    },",
    "    {",
    '      "action": "create",',
    '      "type": "pov_memory",',
    '      "fields": {"summary": "Người dùng怎么记住这件事", "belief": "Người dùng视角判断", "emotion": "Cảm xúc", "attitude": "Thái độ", "certainty": "certain", "about": "evt1"},',
    '      "scope": {"layer": "pov", "ownerType": "user", "ownerId": "Người dùng名", "ownerName": "Người dùng名"}',
    "    }",
    "  ],",
    '  "cognitionUpdates": [',
    "    {",
    '      "ownerType": "character",',
    '      "ownerName": "Ailin",',
    '      "ownerNodeId": "char-1",',
    '      "knownRefs": ["evt1", "char2"],',
    '      "mistakenRefs": ["evt2"],',
    '      "visibility": [',
    '        {"ref": "evt1", "score": 1.0, "reason": "direct witness"},',
    '        {"ref": "thread-1", "score": 0.55, "reason": "heard nearby"}',
    "      ]",
    "    }",
    "  ],",
    '  "regionUpdates": {',
    '    "activeRegionHint": "Tháp chuông",',
    '    "adjacency": [',
    '      {"region": "Tháp chuông", "adjacent": ["Khu phố cũ", "Nội đình"]}',
    "    ]",
    "  }",
    "}",
    "",
    "Quy tắc：",
    "- 每批对话最多创建 1 个Sự kiệnnút，多个子Sự kiện合并为一条",
    "- batchStoryTime 表示这批对话主叙事所处的剧情时间；普通当前场景尽量填写，推不出来就留空",
    "- operations[].storyTime 用于nút自己的剧情时间；不写时系统会继承 batchStoryTime",
    "- 必须区分聊天顺序和剧情顺序，不要把“后说到”误当成“后发生”",
    "- flashback / hypothetical / future 可以写 storyTime，但通常不要把 advancesActiveTimeline 设为 true",
    "- 涉及到的Nhân vật都尽量尝试生成对应 POV Ký ức和 cognitionUpdates；不必强行覆盖全图所有Nhân vật",
    "- cognitionUpdates 用来表达谁确定知道、谁误解了什么、谁只是模糊可见",
    "- 多Nhân vật场景里，pov_memory 和 cognitionUpdates 必须写清具体人物；不要把Nhân vật卡名当作 POV owner",
    "- 只有在这一批明显只涉及一个具体Nhân vật实体时，才允许省略 character POV 的 owner 并让系统安全归属",
    "- knownRefs / mistakenRefs 优先引用同批 ref；没有 ref 再引用现有 nodeId",
    "- regionUpdates 只有在对话里明确出现地区Manh mối时才写；不确定就留空",
    "- Nhân vật/Địa điểmnút：如果图中已有同名同Phạm vi tác dụngnút，用 update 而非 create",
    `- 关系Loại限定：${RELATION_TYPES.join(", ")}`,
    "- contradicts 关系用于矛盾/冲突信息",
    "- evolves 关系用于新信息揭示旧Ký ức需修正的情况",
    "- temporal_update 关系用于实体Trạng thái的时序变化",
    "- 不要虚构Nội dung，只Trích xuất对话中有证据支持的信息",
    "- POV người dùng 不等于Nhân vật已知事实，不要把Người dùng想法伪装成Khách quan事实",
    "- pov_memory 只能用于Ký ức chủ quan，不要拿 character/location/event 去伪装第一视角Ký ức",
    "- 地区不确定就留空，不要硬编",
    "- importance Phạm vi 1-10，普通Sự kiện 5，关键转折 8+",
    "- event.fields.title 需要是Tên sự kiện ngắn，建议 6-10 字，只用于đồ thị和列表显示",
    "- summary 应该是tóm tắt抽象，不要复制原文",
  ].join("\n");
}

function buildCognitiveExtractAugmentPrompt() {
  return [
    "增强Yêu cầu：这一轮Trích xuất除了 operations，还要尽量补 cognitionUpdates 与 regionUpdates。",
    "- cognitionUpdates 表达谁明确知道哪些Khách quannút、谁产生了误解、谁只是低置信可见。",
    "- 本批涉及到的Nhân vật都尽量尝试生成 POV 和Ký ức认知Cập nhật，不必覆盖全图Tất cảNhân vật。",
    "- ownerType 只能是 character 或 user；ownerName 必须写清楚Tên nhân vật或Người dùng名。",
    "- 不要把Nhân vật卡名、旁白身份或群像统称当成 POV owner；多Nhân vật时一定写具体人物。",
    "- knownRefs / mistakenRefs 优先引用同批 ref，没有 ref 再用现有 nodeId。",
    "- visibility.score 取 0..1，1 表示亲历或明确得知，0.5 左右表示间接听闻。",
    "- regionUpdates.activeRegionHint 只在这批对话明确落到某个地区时填写。",
    "- regionUpdates.adjacency 只在文本里明确出现邻接关系时填写，不要猜。",
    "- batchStoryTime.label 尽量写成可复用的剧情时间标签，例如“Sáng sớm ngày thứ hai”“昨夜之后”“回忆里的童年时期”。",
    "- advancesActiveTimeline 只有在这批确实推动当前主叙事时间线时才写 true。",
    "- 若没有认知或空间变化，可返回空数组或空đối tượng，但不要返回Không效Cấu trúc。",
  ].join("\n");
}

// ==================== v2 增强功能 ====================

/**
 * Toàn cục故事概要生成（MemoRAG 启发）
 * 基于图中Sự kiện/Nhân vật/tuyến chínhTự động生成/Cập nhật synopsis nút
 *
 * @param {object} params
 * @param {object} params.graph
 * @param {object[]} params.schema
 * @param {number} params.currentSeq
 * @returns {Promise<void>}
 */
export async function generateSynopsis({
  graph,
  schema,
  currentSeq,
  customPrompt,
  signal,
  settings = {},
}) {
  const eventNodes = getActiveNodes(graph, "event").sort(
    (a, b) => a.seq - b.seq,
  );

  if (eventNodes.length < 3) return;

  const eventSummaries = eventNodes
    .map((n) => {
      const storyLabel = describeNodeStoryTime(n);
      return `[楼${n.seq}]${storyLabel ? ` [${storyLabel}]` : ""} ${n.fields.summary || "(Không)"}`;
    })
    .join("\n");

  const characterNodes = getActiveNodes(graph, "character");
  const charSummary = characterNodes
    .map((n) => `${n.fields.name}: ${n.fields.state || "(KhôngTrạng thái)"}`)
    .join("; ");

  const threadNodes = getActiveNodes(graph, "thread");
  const threadSummary = threadNodes
    .map((n) => {
      const storyLabel = describeNodeStoryTime(n);
      return `${n.fields.title}: ${n.fields.status || "active"}${storyLabel ? `（${storyLabel}）` : ""}`;
    })
    .join("; ");
  const synopsisStoryTimeSpan = deriveStoryTimeSpanFromNodes(
    graph,
    [...eventNodes, ...threadNodes],
    "derived",
  );

  const synopsisPromptBuild = await buildTaskPrompt(settings, "synopsis", {
    taskName: "synopsis",
    eventSummary: eventSummaries,
    characterSummary: charSummary || "(Không)",
    threadSummary: threadSummary || "(Không)",
    graphStats: `event=${eventNodes.length}, character=${characterNodes.length}, thread=${threadNodes.length}`,
    ...getSTContextForPrompt(),
  });
  const synopsisRegexInput = { entries: [] };
  const synopsisSystemPrompt = applyTaskRegex(
    settings,
    "synopsis",
    "finalPrompt",
    synopsisPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "你是故事概要生成器。根据Sự kiện线、Nhân vật和tuyến chính生成简洁的前情提要。",
        '输出 JSON：{"summary": "前情提要文本（200字以内）"}',
        "Yêu cầu：涵盖核心冲突、关键转折、主要Nhân vậtTrạng thái hiện tại。",
      ].join("\n"),
    synopsisRegexInput,
    "system",
  );

  const synopsisUserPrompt = [
      "## Sự kiện时间线",
      eventSummaries,
      "",
      "## Nhân vậtTrạng thái",
      charSummary || "(Không)",
      "",
      "## 活跃tuyến chính",
      threadSummary || "(Không)",
    ].join("\n");
  const synopsisPromptPayload = resolveTaskPromptPayload(
    synopsisPromptBuild,
    synopsisUserPrompt,
  );

  const result = await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(
      synopsisPromptPayload,
      synopsisSystemPrompt,
    ),
    userPrompt: synopsisPromptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType: "synopsis",
    debugContext: createTaskLlmDebugContext(
      synopsisPromptBuild,
      synopsisRegexInput,
    ),
    promptMessages: synopsisPromptPayload.promptMessages,
    additionalMessages: synopsisPromptPayload.additionalMessages,
  });

  if (!result?.summary) return;

  const existingSynopsis = graph.nodes.find(
    (n) => n.type === "synopsis" && !n.archived,
  );

  if (existingSynopsis) {
    updateNode(graph, existingSynopsis.id, {
      fields: { summary: result.summary, scope: `Tầng 1 ~ ${currentSeq}` },
      seq: Math.max(existingSynopsis.seq || 0, currentSeq),
      storyTimeSpan: synopsisStoryTimeSpan,
    });
    existingSynopsis.seqRange = [
      Math.min(existingSynopsis.seqRange?.[0] ?? currentSeq, currentSeq),
      Math.max(existingSynopsis.seqRange?.[1] ?? currentSeq, currentSeq),
    ];
    existingSynopsis.embedding = null;
    debugLog("[ST-BME] Toàn cục概要Đã cập nhật");
  } else {
    const node = createNode({
      type: "synopsis",
      fields: { summary: result.summary, scope: `Tầng 1 ~ ${currentSeq}` },
      seq: currentSeq,
      importance: 9.0,
    });
    node.storyTimeSpan = synopsisStoryTimeSpan;
    addNode(graph, node);
    debugLog("[ST-BME] Toàn cục概要已创建");
  }
}

export async function generateReflection({
  graph,
  currentSeq,
  schema = [],
  embeddingConfig,
  customPrompt,
  signal,
  settings = {},
}) {
  const recentEvents = getActiveNodes(graph, "event")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 6)
    .reverse();

  if (recentEvents.length < 2) return null;

  const recentCharacters = getActiveNodes(graph, "character")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 5);

  const recentThreads = getActiveNodes(graph, "thread")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 4);

  const contradictEdges = graph.edges
    .filter((e) => e.relation === "contradicts" && !e.invalidAt)
    .slice(-5);

  const eventSummary = recentEvents
    .map((n) => {
      const storyLabel = describeNodeStoryTime(n);
      return `[楼${n.seq}]${storyLabel ? ` [${storyLabel}]` : ""} ${n.fields.summary || "(Không)"}`;
    })
    .join("\n");
  const characterSummary = recentCharacters
    .map(
      (n) =>
        `${n.fields.name || n.fields.title || n.id}: ${n.fields.state || n.fields.summary || "(Không)"}`,
    )
    .join("\n");
  const threadSummary = recentThreads
    .map(
      (n) =>
        `${n.fields.title || n.fields.name || n.id}: ${n.fields.status || n.fields.summary || "active"}${describeNodeStoryTime(n) ? `（${describeNodeStoryTime(n)}）` : ""}`,
    )
    .join("\n");
  const reflectionStoryTimeSpan = deriveStoryTimeSpanFromNodes(
    graph,
    [...recentEvents, ...recentThreads],
    "derived",
  );
  const contradictionSummary = contradictEdges
    .map((e) => `${e.fromId} -> ${e.toId} (${e.relation})`)
    .join("\n");
  const reflectionGraphStats = await buildTaskGraphStats({
    graph,
    schema,
    userMessage: buildReflectionRankingQueryText({
      eventSummary,
      characterSummary,
      threadSummary,
      contradictionSummary,
    }),
    recentMessages: [],
    embeddingConfig,
    signal,
    rankingOptions: {
      topK: 12,
      diffusionTopK: 48,
      enableContextQueryBlend: false,
      enableMultiIntent: true,
      maxTextLength: 1200,
    },
    relevantHeading: "与当前Phản tư最相关的既有nút",
  });

  const reflectionPromptBuild = await buildTaskPrompt(settings, "reflection", {
    taskName: "reflection",
    eventSummary,
    characterSummary: characterSummary || "(Không)",
    threadSummary: threadSummary || "(Không)",
    contradictionSummary: contradictionSummary || "(Không)",
    graphStats: reflectionGraphStats.graphStats,
    ...getSTContextForPrompt(),
  });
  const reflectionRegexInput = { entries: [] };
  const reflectionSystemPrompt = applyTaskRegex(
    settings,
    "reflection",
    "finalPrompt",
    reflectionPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "你是 RP 长期Ký ức系统的Phản tư生成器。",
        '输出严格 JSON：{"insight":"...","trigger":"...","suggestion":"...","importance":1-10}',
        "insight 应总结Gần nhất情节中最值得长期保留的变化、关系趋势或潜在Manh mối。",
        "trigger 说明触发这条Phản tư的关键Sự kiện或矛盾。",
        "suggestion 给出后续检索或叙事上值得关注的提示。",
        "不要复述Tất cảSự kiện，要提炼高层结论。",
      ].join("\n"),
    reflectionRegexInput,
    "system",
  );

  const reflectionUserPrompt = [
      "## Gần nhấtSự kiện",
      eventSummary,
      "",
      "## 近期Nhân vậtTrạng thái",
      characterSummary || "(Không)",
      "",
      "## 当前tuyến chính",
      threadSummary || "(Không)",
      "",
      "## 已知矛盾",
      contradictionSummary || "(Không)",
    ].join("\n");
  const reflectionPromptPayload = resolveTaskPromptPayload(
    reflectionPromptBuild,
    reflectionUserPrompt,
  );

  const result = await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(
      reflectionPromptPayload,
      reflectionSystemPrompt,
    ),
    userPrompt: reflectionPromptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType: "reflection",
    debugContext: createTaskLlmDebugContext(
      reflectionPromptBuild,
      reflectionRegexInput,
    ),
    promptMessages: reflectionPromptPayload.promptMessages,
    additionalMessages: reflectionPromptPayload.additionalMessages,
  });

  if (!result?.insight) return null;

  const reflectionNode = createNode({
    type: "reflection",
    fields: {
      insight: result.insight,
      trigger:
        result.trigger ||
        recentEvents[recentEvents.length - 1]?.fields?.summary ||
        "",
      suggestion: result.suggestion || "",
    },
    seq: currentSeq,
    importance: Math.max(5, Math.min(10, result.importance ?? 7)),
  });
  reflectionNode.storyTimeSpan = reflectionStoryTimeSpan;
  addNode(graph, reflectionNode);

  for (const eventNode of recentEvents.slice(-3)) {
    const edge = createEdge({
      fromId: reflectionNode.id,
      toId: eventNode.id,
      relation: "evolves",
      strength: 0.75,
      edgeType: 0,
    });
    addEdge(graph, edge);
  }

  debugLog("[ST-BME] Phản tư条目已生成");
  return reflectionNode.id;
}
