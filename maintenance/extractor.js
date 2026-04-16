// ST-BME: LLM Ký ứcTrích xuấtPipeline（ghi vàođường đi）
// Phân tích hội thoại → trích xuất nút và quan hệ → cập nhật đồ thị
// v2: hòa trộn đối chiếu chính xác kiểu Mem0 + cạnh thời gian kiểu Graphiti + tóm lược toàn cục kiểu MemoRAG

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
        ? `Tầng ${entry.messageRange[0]}~${entry.messageRange[1]}`
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
    parts.push(`Thời gian cốt truyện đang hoạt động: ${storyCtx.activeStoryTimeLabel}`);
  }
  if (storyCtx.source) {
    parts.push(`Nguồn：${storyCtx.source}`);
  }
  const seg = storyCtx.segment;
  if (seg?.tense && seg.tense !== "unknown") {
    parts.push(`Thì thời gian：${seg.tense}`);
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
    characterSummary ? `Trạng thái nhân vật gần đây:\n${characterSummary}` : "",
    threadSummary ? `hiện tạituyến chính:\n${threadSummary}` : "",
    contradictionSummary ? `đã biếtmâu thuẫn:\n${contradictionSummary}` : "",
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
 * Phán định xem một đối tượng có trông như một thao tác extraction hay không
 * (bao gồm ít nhất một trong các trường action/op/operation/type)
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
  // Nếu trực tiếp là mảng thì trả về luôn
  if (Array.isArray(result)) {
    return result;
  }
  if (!isPlainObject(result)) {
    return null;
  }

  // 1. Ưu tiên khớp khóa container đã biết
  for (const key of EXTRACTION_RESULT_CONTAINER_KEYS) {
    if (Array.isArray(result[key])) {
      return result[key];
    }
  }

  // 2. Thăm dò thông minh: quét khóa đầu tiên có giá trị là mảng không rỗng và phần tử trông như thao tác
  for (const [key, value] of Object.entries(result)) {
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.some((item) => looksLikeSingleOperation(item))
    ) {
      debugLog(
        `[ST-BME] Tự động dò thấy khóa container không chuẩn: "${key}" (${value.length} mục)`,
      );
      return value;
    }
  }

  // 3. Đường lùi cho đối tượng thao tác đơn: nếu toàn bộ kết quả trông như một thao tác thì bọc thành mảng
  if (looksLikeSingleOperation(result)) {
    debugLog(
      "[ST-BME] LLM đã trả về một đối tượng thao tác đơn, tự động bọc thành mảng",
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
 * Thực thi trích xuất ký ức cho các tầng hội thoại chưa xử lý
 *
 * @param {object} params
 * @param {object} params.graph - trạng thái đồ thị hiện tại
 * @param {Array<{seq?: number, role: string, content: string}>} params.messages - tin nhắn hội thoại cần xử lý
 * @param {number} params.startSeq - chỉ mục chat của tin nhắn assistant đầu tiên được xử lý trong lô này
 * @param {number} params.endSeq - chỉ mục chat của tin nhắn assistant cuối cùng được xử lý trong lô này
 * @param {number} [params.lastProcessedSeq] - chỉ mục chat đã xử lý tới ở lần trước
 * @param {object[]} params.schema - nútLoại Schema
 * @param {object} params.embeddingConfig - Embedding Cấu hình API
 * @param {string} [params.extractPrompt] - prompt trích xuất tự định nghĩa
 * @param {object} [params.v2Options] - v2 tăng cườngtùy chọn
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
    `[ST-BME] Trích xuấtbắt đầu: chat[${effectiveStartSeq}..${effectiveEndSeq}], ${messages.length}  tin nhắn`,
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
    relevantHeading: "Các nút đã có liên quan nhất tới đoạn trích xuất hiện tại",
  });
  const extractGraphRanking = extractGraphStats.ranking;
  const extractGraphRelevantNodes = extractGraphStats.relevantReferenceMap;
  const graphOverview = extractGraphStats.graphStats;

  // xây dựng Schema mô tả
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

  // prompt hệ thống
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

  // Prompt người dùng — Cấu trúc thông tin phân tầng của Phase 3
  const userPromptSections = [];

  // Layer 1: lát cắt hội thoại hiện tại (phân biệt ngữ cảnh nhìn lại và mục tiêu trích xuất)
  {
    const hasContextMessages = structuredMessages.some((m) => m?.isContextOnly === true);
    const hasTargetMessages = structuredMessages.some((m) => m?.isContextOnly !== true);
    if (dialogueText) {
      if (hasContextMessages && hasTargetMessages) {
        userPromptSections.push(
          "## hội thoạiNội dung",
          "Hội thoại dưới đây gồm hai phần: ngữ cảnh nhìn lại đã từng được trích xuất (chỉ để hiểu tiền cảnh) và nội dung mới cần trích xuất ký ức ở lượt này." +
            "Hãy **chỉ trích xuất ký ức từ phần nội dung mới**, đừng lặp lại thông tin đã có trong phần ngữ cảnh nhìn lại.",
          dialogueText,
          "",
        );
      } else {
        userPromptSections.push("## Nội dung hội thoại hiện tại (cần trích xuất ký ức)", dialogueText, "");
      }
    } else if (structuredMode === "structured" && structuredMessages.length > 0) {
      if (hasContextMessages && hasTargetMessages) {
        userPromptSections.push(
          "## Nội dung hội thoại (tin nhắn có cấu trúc)",
          "Tin nhắn có cấu trúc dưới đây gồm hai phần: phần được đánh dấu isContextOnly là ngữ cảnh nhìn lại đã từng được trích xuất (chỉ để hiểu tiền cảnh)," +
            "phần còn lại là nội dung mới cần trích xuất ký ức ở lượt này. Hãy **chỉ trích xuất ký ức từ các tin nhắn có isContextOnly = false**." +
            "(Tin nhắn có cấu trúc đã được tiêm qua profile blocks, hãy tham khảo khối recentMessages ở phía trên.)",
          "",
        );
      } else {
        userPromptSections.push(
          "## Nội dung hội thoại hiện tại (tin nhắn có cấu trúc, cần trích xuất ký ức)",
          "(Tin nhắn có cấu trúc đã được tiêm qua profile blocks, hãy tham khảo khối recentMessages ở phía trên.)",
          "",
        );
      }
    }
  }

  // Layer 2: đồ thị hiện tạiTrạng thái
  userPromptSections.push(
    "## đồ thị hiện tạiTrạng thái",
    graphOverview || "(Đồ thị trống, chưa có nút)",
    "",
  );

  // Layer 3: snapshot tổng kết đã có (giúp tránh trích xuất lặp)
  if (activeSummaries) {
    userPromptSections.push(
      "## Tóm tắt cục diện gần đây (đã bao phủ, tránh trùng lặp)",
      activeSummaries,
      "",
    );
  }

  // Layer 4: vị trí trên trục thời gian cốt truyện
  if (storyTimeContext) {
    userPromptSections.push(
      "## hiện tạiThời gian cốt truyện",
      storyTimeContext,
      "",
    );
  }

  // Layer 5: nútLoạiđịnh nghĩa
  userPromptSections.push("## nútLoạiđịnh nghĩa", schemaDescription, "");

  userPromptSections.push("Hãy phân tích hội thoại và xuất danh sách thao tác theo định dạng JSON.");
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

  // chẩn đoán：Theo dõi promptPayload
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

  // gọi LLM
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
      `[ST-BME] Trích xuất LLM không trả vềhợp lệThao tác ` +
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
        ? `Trích xuất LLM không trả vềhợp lệThao tác: ${failureReason}`
        : "Trích xuất LLM không trả vềhợp lệThao tác",
      newNodes: 0,
      updatedNodes: 0,
      newEdges: 0,
      newNodeIds: [],
      processedRange: [lastProcessedSeq, lastProcessedSeq],
    };
  }

  // thực thiThao tác
  const stats = { newNodes: 0, updatedNodes: 0, newEdges: 0 };
  const newNodeIds = []; // v2: thu thập ID nút mới tạo (dùng cho engine tiến hóa)
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
          // Đối chiếu kiểu Mem0 phán định là trùng lặp, bỏ qua
          break;
        default: {
          const message = `[ST-BME] Thao tác không rõLoại: ${op?.action ?? "<missing>"}`;
          console.warn(message, op);
          operationErrors.push(message);
          break;
        }
      }
    } catch (e) {
      console.error(`[ST-BME] Thao tácthực thiThất bại:`, op, e);
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

  // Sinh embedding cho nút mới. Nếu thất bại thì không nên hoàn tác cả lô ghi vào đồ thị.
  try {
    await generateNodeEmbeddings(graph, embeddingConfig, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.error("[ST-BME] nút embedding Sinh thất bại，giữ lạiđồ thịghi vào:", error);
  }

  // Cập nhật tiến độ xử lý: thống nhất ghi lại chỉ mục chat cuối cùng đã xử lý
  graph.lastProcessedSeq = Math.max(
    graph.lastProcessedSeq ?? -1,
    effectiveEndSeq,
  );
  const changedNodeIds = [...new Set([...newNodeIds, ...updatedNodeIds])];
  if (ownershipWarnings.length > 0) {
    debugWarn(
      `[ST-BME] Đã bỏ qua ${ownershipWarnings.length} mục ký ức chủ quan hoặc cập nhật nhận thức bị thiếu owner nhân vật cụ thể`,
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
    `[ST-BME] Trích xuấtHoàn tất: Tạo mới ${stats.newNodes}, Cập nhật ${stats.updatedNodes}, cạnh mới ${stats.newEdges}, lastProcessedSeq=${graph.lastProcessedSeq}`,
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

  // Với loại latestOnly: kiểm tra xem đã tồn tại nút cùng tên hay chưa
  if (typeDef.latestOnly && op.fields?.name) {
    const existing = findLatestNode(
      graph,
      op.type,
      op.fields.name,
      "name",
      nodeScope,
    );
    if (existing) {
      // Chuyển thành thao tác cập nhật
      updateNode(graph, existing.id, { fields: op.fields, seq, scope: nodeScope });
      applyOperationStoryTimeToNode(graph, existing, op, batchStoryTime);
      stats.updatedNodes++;

      if (op.ref) refMap.set(op.ref, existing.id);

      // Xử lý cạnh liên kết
      if (op.links) {
        handleLinks(graph, existing.id, op.links, refMap, stats);
      }
      return null;
    }
  }

  // Tạo nút mới
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

  // Lưu ref để tham chiếu trong cùng lô
  if (op.ref) {
    refMap.set(op.ref, node.id);
  }

  // Xử lý cạnh liên kết
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
    console.warn("[ST-BME] update Thao tácthiếu nodeId");
    return "";
  }

  const previousNode = getNode(graph, op.nodeId);
  if (!previousNode) {
    console.warn(`[ST-BME] Nút mục tiêu của update không tồn tại: ${op.nodeId}`);
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

    // v2 Graphiti: đánh dấu các cạnh updates/temporal_update cũ là mất hiệu lực
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

    const beforeText = before == null || before === "" ? "rỗng" : String(before);
    const afterText = after == null || after === "" ? "rỗng" : String(after);
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
    node.archived = true; // xóa mềm
  }
}

/**
 * Xử lý cạnh liên kết
 */
function handleLinks(graph, sourceId, links, refMap, stats) {
  const sourceNode = getNode(graph, sourceId);
  const sourceScope = normalizeMemoryScope(sourceNode?.scope);
  for (const link of links) {
    let targetId = link.targetNodeId || null;

    // thông qua ref phân tíchmục tiêunút
    if (!targetId && link.targetRef) {
      targetId = refMap.get(link.targetRef);
    }

    if (!targetId) continue;

    // xác thựcquan hệLoại
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
 * Sinh vector cho các nút thiếu embedding
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

  debugLog(`[ST-BME] Sinh embedding cho ${texts.length} nút`);

  const embeddings = await embedBatch(texts, embeddingConfig, { signal });

  for (let i = 0; i < needsEmbedding.length; i++) {
    if (embeddings[i]) {
      needsEmbedding[i].embedding = Array.from(embeddings[i]);
    }
  }
}

/**
 * xây dựng Schema mô tảvăn bản
 */
function buildSchemaDescription(schema) {
  return schema
    .map((t) => {
      const cols = t.columns
         .map((c) => `${c.name}${c.required ? "(bắt buộc)" : ""}: ${c.hint}`)
        .join("\n    ");
      return `Loại "${t.id}" (${t.label}):\n    ${cols}`;
    })
    .join("\n\n");
}

/**
 * xây dựngMặc địnhTrích xuấtprompt
 */
function buildDefaultExtractPrompt(schema) {
  const typeNames = schema.map((s) => `${s.id}(${s.label})`).join(", ");

  return [
    "Bạn là bộ phân tích trích xuất ký ức. Hãy trích xuất các nút ký ức có cấu trúc từ hội thoại và lưu vào đồ thị tri thức.",
    "",
    `Các loại nút được hỗ trợ: ${typeNames}`,
    "",
    "Ở lượt này bắt buộc phải đồng thời xét ba tầng thông tin:",
    "- Sự thật khách quan: tiếp tục ghi vào event / character / location / thread / rule / synopsis / reflection",
    '- Ký ức chủ quan: thống nhất ghi vào pov_memory, dùng scope.layer = "pov"',
    "- Quy thuộc khu vực: nếu phán định được thì ghi vào scope.regionPrimary / regionPath / regionSecondary, không phán định được thì để trống",
    "",
    "Đầu ra phải là JSON nghiêm ngặt:",
    "{",
    '  "thought": "Phân tích của bạn về đoạn hội thoại này (sự kiện/thay đổi nhân vật/thông tin mới/ai hiểu điều gì như thế nào)",',
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
    '      "fields": {"summary": "Nhân vật ghi nhớ chuyện này như thế nào", "belief": "Cô ấy cho rằng đã xảy ra chuyện gì", "emotion": "Cảm xúc", "attitude": "Thái độ", "certainty": "unsure", "about": "evt1"},',
    '      "scope": {"layer": "pov", "ownerType": "character", "ownerId": "Tên nhân vật", "ownerName": "Tên nhân vật", "regionPrimary": "Khu vực chính", "regionPath": ["Khu vực cấp trên", "Khu vực chính"]}',
    "    },",
    "    {",
    '      "action": "create",',
    '      "type": "pov_memory",',
    '      "fields": {"summary": "Người dùng ghi nhớ chuyện này như thế nào", "belief": "Phán định từ góc nhìn người dùng", "emotion": "Cảm xúc", "attitude": "Thái độ", "certainty": "certain", "about": "evt1"},',
    '      "scope": {"layer": "pov", "ownerType": "user", "ownerId": "Tên người dùng", "ownerName": "Tên người dùng"}',
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
    "Quy tắc:",
    "- Mỗi lô hội thoại tối đa chỉ tạo 1 nút sự kiện; nhiều tiểu sự kiện phải hợp nhất thành một mục",
    "- batchStoryTime biểu thị thời gian cốt truyện của tuyến tự sự chính trong lô hội thoại này; thông thường hãy cố điền cảnh hiện tại, nếu không suy ra được thì để trống",
    "- operations[].storyTime dùng cho thời gian cốt truyện riêng của nút; nếu không ghi thì hệ thống sẽ kế thừa batchStoryTime",
    "- Bắt buộc phải phân biệt thứ tự chat và thứ tự cốt truyện; đừng nhầm "được nhắc sau" thành "xảy ra sau"",
    "- Flashback / hypothetical / future có thể ghi storyTime, nhưng thông thường đừng đặt advancesActiveTimeline = true",
    "- Với các nhân vật có liên quan, hãy cố gắng sinh POV memory và cognitionUpdates tương ứng; không cần ép bao phủ toàn bộ nhân vật trong đồ thị",
    "- cognitionUpdates dùng để thể hiện ai biết chắc điều gì, ai hiểu sai điều gì, ai chỉ thấy mơ hồ",
    "- Trong cảnh nhiều nhân vật, pov_memory và cognitionUpdates bắt buộc phải ghi rõ nhân vật cụ thể; đừng dùng tên thẻ nhân vật làm POV owner",
    "- Chỉ khi lô này rõ ràng chỉ liên quan tới một thực thể nhân vật cụ thể thì mới được phép bỏ owner của character POV và để hệ thống quy thuộc an toàn",
    "- knownRefs / mistakenRefs ưu tiên tham chiếu ref trong cùng lô; nếu không có ref thì mới dùng nodeId hiện có",
    "- Chỉ ghi regionUpdates khi trong hội thoại xuất hiện manh mối khu vực một cách rõ ràng; không chắc thì để trống",
    "- Với nút nhân vật/địa điểm: nếu trong đồ thị đã có nút cùng tên và cùng phạm vi tác dụng thì dùng update thay vì create",
    `- Loại quan hệ bị giới hạn trong: ${RELATION_TYPES.join(", ")}`,
    "- Quan hệ contradicts dùng cho thông tin mâu thuẫn/xung đột",
    "- Quan hệ evolves dùng cho trường hợp thông tin mới tiết lộ rằng ký ức cũ cần sửa",
    "- Quan hệ temporal_update dùng cho thay đổi trạng thái của thực thể theo thời gian",
    "- Đừng bịa nội dung, chỉ trích xuất thông tin có bằng chứng hỗ trợ trong hội thoại",
    "- POV của người dùng không đồng nghĩa với việc nhân vật đã biết sự thật; đừng ngụy trang suy nghĩ của người dùng thành sự thật khách quan",
    "- pov_memory chỉ được dùng cho ký ức chủ quan; đừng dùng character/location/event để ngụy trang ký ức ở góc nhìn ngôi thứ nhất",
    "- Nếu khu vực không chắc chắn thì để trống, đừng cố bịa",
    "- importance nằm trong phạm vi 1-10; sự kiện thông thường là 5, bước ngoặt then chốt là 8+",
    "- event.fields.title cần là tên sự kiện ngắn, khuyến nghị 6-10 ký tự, chỉ dùng cho đồ thị và danh sách hiển thị",
    "- summary nên là phần tóm tắt mang tính khái quát, đừng chép nguyên văn",
  ].join("\n");
}

function buildCognitiveExtractAugmentPrompt() {
  return [
    "Yêu cầu tăng cường: ở lượt trích xuất này, ngoài operations còn phải cố gắng bổ sung cognitionUpdates và regionUpdates.",
    "- cognitionUpdates thể hiện ai biết rõ nút khách quan nào, ai sinh ra hiểu sai và ai chỉ có khả năng nhìn thấy với độ tin cậy thấp.",
    "- Với các nhân vật liên quan trong lô này, hãy cố gắng sinh POV và cập nhật nhận thức ký ức, không cần bao phủ tất cả nhân vật trong đồ thị.",
    "- ownerType chỉ được là character hoặc user; ownerName bắt buộc phải ghi rõ tên nhân vật hoặc tên người dùng.",
    "- Đừng lấy tên thẻ nhân vật, danh xưng lời dẫn hay tên gọi tập thể làm POV owner; khi có nhiều nhân vật thì nhất định phải ghi rõ người cụ thể.",
    "- knownRefs / mistakenRefs ưu tiên tham chiếu ref trong cùng lô; nếu không có ref thì mới dùng nodeId hiện có.",
    "- visibility.score lấy trong khoảng 0..1; 1 biểu thị trực tiếp trải qua hoặc biết chắc, khoảng 0.5 biểu thị nghe gián tiếp.",
    "- regionUpdates.activeRegionHint chỉ điền khi lô hội thoại này rơi rõ ràng vào một khu vực nào đó.",
    "- regionUpdates.adjacency chỉ điền khi trong văn bản có quan hệ kề cận được nêu rõ, đừng đoán.",
    "- batchStoryTime.label nên được viết thành nhãn thời gian cốt truyện có thể tái sử dụng, ví dụ "Sáng sớm ngày thứ hai", "Sau đêm qua", "Thời thơ ấu trong hồi ức".",
    "- advancesActiveTimeline chỉ được viết là true khi lô này thực sự đẩy tuyến thời gian tự sự chính hiện tại tiến về phía trước.",
    "- Nếu không có thay đổi về nhận thức hoặc không gian thì có thể trả về mảng rỗng hoặc đối tượng rỗng, nhưng đừng trả về cấu trúc không hợp lệ.",
  ].join("\n");
}

// ==================== Chức năng tăng cường v2 ====================

/**
 * Sinh tóm lược câu chuyện toàn cục (lấy cảm hứng từ MemoRAG)
 * Tự động sinh/cập nhật nút synopsis dựa trên sự kiện/nhân vật/tuyến chính trong đồ thị
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
      return `[Tầng ${n.seq}]${storyLabel ? ` [${storyLabel}]` : ""} ${n.fields.summary || "(Không)"}`;
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
        "Bạn là bộ sinh tóm lược câu chuyện. Hãy dựa trên tuyến sự kiện, nhân vật và tuyến chính để tạo ra bản tóm lược bối cảnh trước đó ngắn gọn.",
        'đầu ra JSON: {"summary": "văn bản tóm lược bối cảnh trước đó (không quá 200 ký tự)"}',
        "Yêu cầu: bao phủ xung đột cốt lõi, bước ngoặt then chốt và trạng thái hiện tại của các nhân vật chính.",
      ].join("\n"),
    synopsisRegexInput,
    "system",
  );

  const synopsisUserPrompt = [
      "## Trục thời gian sự kiện",
      eventSummaries,
      "",
      "## Nhân vậtTrạng thái",
      charSummary || "(Không)",
      "",
      "## Tuyến chính đang hoạt động",
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
    debugLog("[ST-BME] Đã cập nhật tóm lược toàn cục");
  } else {
    const node = createNode({
      type: "synopsis",
      fields: { summary: result.summary, scope: `Tầng 1 ~ ${currentSeq}` },
      seq: currentSeq,
      importance: 9.0,
    });
    node.storyTimeSpan = synopsisStoryTimeSpan;
    addNode(graph, node);
    debugLog("[ST-BME] Đã tạo tóm lược toàn cục");
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
      return `[Tầng ${n.seq}]${storyLabel ? ` [${storyLabel}]` : ""} ${n.fields.summary || "(Không)"}`;
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
    relevantHeading: "Các nút đã có liên quan nhất tới lần phản tư hiện tại",
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
        "Bạn là bộ sinh phản tư cho hệ thống ký ức dài hạn của RP.",
        'đầu ra JSON nghiêm ngặt: {"insight":"...","trigger":"...","suggestion":"...","importance":1-10}',
        "insight nên tổng kết thay đổi, xu hướng quan hệ hoặc manh mối tiềm ẩn đáng để giữ lại lâu dài nhất trong diễn biến gần đây.",
        "trigger mô tả sự kiện then chốt hoặc mâu thuẫn đã kích hoạt dòng phản tư này.",
        "suggestion đưa ra lời nhắc đáng chú ý cho việc truy xuất hoặc tự sự về sau.",
        "Đừng kể lại toàn bộ sự kiện, hãy chắt lọc kết luận ở tầng cao hơn.",
      ].join("\n"),
    reflectionRegexInput,
    "system",
  );

  const reflectionUserPrompt = [
      "## Sự kiện gần nhất",
      eventSummary,
      "",
      "## Trạng thái nhân vật gần đây",
      characterSummary || "(Không)",
      "",
      "## Tuyến chính hiện tại",
      threadSummary || "(Không)",
      "",
      "## Mâu thuẫn đã biết",
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

  debugLog("[ST-BME] Đã sinh mục phản tư");
  return reflectionNode.id;
}

