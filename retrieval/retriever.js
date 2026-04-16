// ST-BME: điều phối truy xuất trộn ba tầng
// hòa trộnLọc trước bằng vector（PeroCore）+ Khuếch tán đồ thị（PeroCore PEDSA）+ tùy chọn Truy hồi chính xác bằng LLM
// v2: + lọc biên nhận thức (RoleRAG) + truy xuất chéo hai lớp ký ức (AriGraph) + kích hoạt xác suất

import { debugLog } from "../runtime/debug-logging.js";
import { diffuseAndRank } from "./diffusion.js";
import { hybridScore, reinforceAccessBatch } from "./dynamics.js";
import {
  buildTemporalAdjacencyMap,
  getActiveNodes,
  getNode,
  getNodeEdges,
} from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
  EXTRACTION_CONTEXT_REVIEW_HEADER,
  RECALL_TARGET_CONTENT_HEADER,
} from "../prompting/prompt-builder.js";
import {
  applyCooccurrenceBoost,
  applyDiversitySampling,
  collectSupplementalAnchorNodeIds,
  createCooccurrenceIndex,
  isEligibleAnchorNode,
  runResidualRecall,
} from "./retrieval-enhancer.js";
import {
  MEMORY_SCOPE_BUCKETS,
  classifyNodeScopeBucket,
  describeMemoryScope,
  describeScopeBucket,
  getScopeRegionKey,
  normalizeMemoryScope,
  resolveScopeBucketWeight,
} from "../graph/memory-scope.js";
import { rankNodesForTaskContext } from "./shared-ranking.js";
import {
  computeKnowledgeGateForNode,
  listKnowledgeOwners,
  pushRecentRecallOwner,
  resolveActiveRegionContext,
  resolveAdjacentRegions,
  resolveKnowledgeOwner,
  resolveKnowledgeOwnerKeyFromScope,
} from "../graph/knowledge-state.js";
import {
  classifyStoryTemporalBucket,
  describeNodeStoryTime,
  resolveActiveStoryContext,
  resolveStoryCueMode,
  STORY_TEMPORAL_BUCKETS,
} from "../graph/story-timeline.js";
import { getActiveSummaryEntries } from "../graph/summary-state.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { createPromptNodeReferenceMap } from "../prompting/prompt-node-references.js";
import { getSTContextForPrompt } from "../host/st-context.js";

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

function buildRecallSectionedTranscript(recentMessages = []) {
  const lines = (Array.isArray(recentMessages) ? recentMessages : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  const targetLines = [lines[lines.length - 1]].filter(Boolean);
  const contextLines = lines.slice(0, -1).filter(Boolean);
  const sections = [];

  if (contextLines.length > 0) {
    sections.push(
      `${EXTRACTION_CONTEXT_REVIEW_HEADER}\n\n${contextLines.join("\n---\n")}`,
    );
  }
  if (targetLines.length > 0) {
    sections.push(
      `${RECALL_TARGET_CONTENT_HEADER}\n\n${targetLines.join("\n---\n")}`,
    );
  }

  return sections.join("\n\n");
}

function buildRecallFallbackReason(llmResult) {
  const failureType = String(llmResult?.errorType || "").trim();
  const failureReason = String(llmResult?.failureReason || "").trim();
  switch (failureType) {
    case "timeout":
      return "LLM xếp hạng tinhyêu cầuquá thời gian，Đã lùi vềđến bước chấm điểm và xếp hạng";
    case "empty-response":
      return "LLM xếp hạng tinh trả về phản hồi rỗng, đã lùi về bước chấm điểm và xếp hạng";
    case "truncated-json":
      return "Đầu ra của LLM xếp hạng tinh bị cắt ngắn, đã lùi về bước chấm điểm và xếp hạng";
    case "invalid-json":
      return "LLM xếp hạng tinhkhông trả vềhợp lệ JSON，Đã lùi vềđến bước chấm điểm và xếp hạng";
    case "provider-error":
      return failureReason
        ? `LLM xếp hạng tinhGọi thất bại（${failureReason}），Đã lùi vềđến bước chấm điểm và xếp hạng`
        : "LLM xếp hạng tinhGọi thất bại，Đã lùi vềđến bước chấm điểm và xếp hạng";
    default:
      return failureReason || "LLM xếp hạng tinhkhông trả vềdùng đượcKết quả，Đã lùi vềđến bước chấm điểm và xếp hạng";
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError();
  }
}

function nowMs() {
  return typeof performance !== "undefined" && performance?.now
    ? performance.now()
    : Date.now();
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function pushSkipReason(meta, reason) {
  if (!reason) return;
  if (!Array.isArray(meta.skipReasons)) {
    meta.skipReasons = [];
  }
  if (!meta.skipReasons.includes(reason)) {
    meta.skipReasons.push(reason);
  }
}

function createRetrievalMeta(enableLLMRecall) {
  return {
    vectorHits: 0,
    diffusionHits: 0,
    scoredCandidates: 0,
    segmentsUsed: [],
    queryBlendActive: false,
    queryBlendParts: [],
    queryBlendWeights: {},
    vectorMergedHits: 0,
    seedCount: 0,
    temporalSyntheticEdgeCount: 0,
    teleportAlpha: 0,
    lexicalBoostedNodes: 0,
    lexicalTopHits: [],
    cooccurrenceBoostedNodes: 0,
    candidatePoolBeforeDpp: 0,
    candidatePoolAfterDpp: 0,
    diversityApplied: false,
    residualTriggered: false,
    residualHits: 0,
    scopeBuckets: {},
    temporalBuckets: {},
    activeRegion: "",
    activeRegionSource: "",
    activeStorySegmentId: "",
    activeStoryTimeLabel: "",
    activeStoryTimeSource: "",
    activeCharacterPovOwner: "",
    activeUserPovOwner: "",
    activeRecallOwnerKey: "",
    activeRecallOwnerKeys: [],
    activeRecallOwnerScores: {},
    sceneOwnerResolutionMode: "unresolved",
    sceneOwnerCandidates: [],
    bucketWeights: {},
    selectedByBucket: {},
    knowledgeGateMode: "disabled",
    knowledgeAnchoredNodes: [],
    knowledgeSuppressedNodes: [],
    knowledgeRescuedNodes: [],
    knowledgeVisibleOwnersByNode: {},
    knowledgeSuppressedOwnersByNode: {},
    visibilityTopHits: [],
    visibilitySuppressedReasons: {},
    adjacentRegionMatches: [],
    temporalSuppressedNodes: [],
    temporalRescuedNodes: [],
    temporalTopHits: [],
    selectedByStoryTime: {},
    timelineAdvanceApplied: false,
    selectedByKnowledgeState: {},
    selectedByOwner: {},
    skipReasons: [],
    timings: {},
    llm: {
      enabled: enableLLMRecall,
      status: enableLLMRecall ? "pending" : "disabled",
      reason: enableLLMRecall ? "" : "LLM xếp hạng tinhĐã tắt",
      selectionProtocol: "",
      rawSelectedKeys: [],
      resolvedSelectedKeys: [],
      resolvedSelectedNodeIds: [],
      fallbackReason: "",
      fallbackType: "",
      emptySelectionAccepted: false,
      candidateKeyMapPreview: {},
      legacySelectionUsed: false,
      candidatePool: 0,
      selectedSeedCount: 0,
    },
  };
}

function clampPositiveInt(value, fallback, min = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function clampRange(value, fallback, min = 0, max = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeQueryText(value, maxLength = 400) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, Math.max(1, maxLength));
}

function normalizeRecallSelectionList(values = [], maxLength = 64) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= maxLength) break;
  }
  return normalized;
}

function createRecallCandidateKeyMaps(candidates = []) {
  const referenceMap = createPromptNodeReferenceMap(candidates, {
    prefix: "R",
    maxLength: 80,
    buildMeta: ({ entry }) => ({
      scopeBucket: String(entry?.scopeBucket || ""),
      temporalBucket: String(entry?.temporalBucket || ""),
      score:
        Math.round(
          (Number(entry?.weightedScore ?? entry?.finalScore) || 0) * 1000,
        ) / 1000,
    }),
  });
  return {
    candidateKeyToNodeId: referenceMap.keyToNodeId,
    candidateKeyToCandidateMeta: referenceMap.keyToMeta,
    nodeIdToCandidateKey: referenceMap.nodeIdToKey,
  };
}

function normalizeLexicalText(value = "") {
  return normalizeQueryText(value, 600).toLowerCase();
}

function buildLexicalUnits(text = "") {
  const normalized = normalizeLexicalText(text);
  if (!normalized) return [];

  const rawTokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  const units = [];

  for (const token of rawTokens) {
    if (token.length >= 2) {
      units.push(token);
    }
    if (/[\u4e00-\u9fff]/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index++) {
        units.push(token.slice(index, index + 2));
      }
    }
  }

  return [...new Set(units)];
}

function computeTokenOverlapScore(sourceUnits = [], targetUnits = []) {
  if (!sourceUnits.length || !targetUnits.length) return 0;
  const targetSet = new Set(targetUnits);
  let overlap = 0;
  for (const unit of sourceUnits) {
    if (targetSet.has(unit)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, sourceUnits.length);
}

function scoreFieldMatch(
  fieldText,
  querySources = [],
  { exact = 1, includes = 0.9, overlap = 0.6 } = {},
) {
  const normalizedField = normalizeLexicalText(fieldText);
  if (!normalizedField) return 0;

  const fieldUnits = buildLexicalUnits(normalizedField);
  let best = 0;

  for (const sourceText of querySources) {
    const normalizedSource = normalizeLexicalText(sourceText);
    if (!normalizedSource) continue;

    if (normalizedSource === normalizedField) {
      best = Math.max(best, exact);
      continue;
    }

    if (
      Math.min(normalizedSource.length, normalizedField.length) >= 2 &&
      (normalizedSource.includes(normalizedField) ||
        normalizedField.includes(normalizedSource))
    ) {
      best = Math.max(best, includes);
    }

    const overlapScore = computeTokenOverlapScore(
      buildLexicalUnits(normalizedSource),
      fieldUnits,
    );
    best = Math.max(best, overlapScore * overlap);
  }

  return Math.min(1, best);
}

function collectNodeLexicalTexts(node, fieldNames = []) {
  const values = [];
  for (const fieldName of fieldNames) {
    const value = node?.fields?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          values.push(item.trim());
        }
      }
    }
  }
  return values;
}

function computeLexicalScore(node, querySources = []) {
  if (!node || !Array.isArray(querySources) || querySources.length === 0) {
    return 0;
  }

  const primaryTexts = collectNodeLexicalTexts(node, ["name", "title"]);
  const secondaryTexts = collectNodeLexicalTexts(node, [
    "summary",
    "insight",
    "state",
    "traits",
    "participants",
    "status",
  ]);
  const combinedText = [...primaryTexts, ...secondaryTexts].join(" ");

  const primaryScore = primaryTexts.reduce(
    (best, value) =>
      Math.max(
        best,
        scoreFieldMatch(value, querySources, {
          exact: 1,
          includes: 0.92,
          overlap: 0.72,
        }),
      ),
    0,
  );
  const secondaryScore = secondaryTexts.reduce(
    (best, value) =>
      Math.max(
        best,
        scoreFieldMatch(value, querySources, {
          exact: 0.82,
          includes: 0.68,
          overlap: 0.52,
        }),
      ),
    0,
  );
  const tokenScore = scoreFieldMatch(combinedText, querySources, {
    exact: 0.65,
    includes: 0.55,
    overlap: 0.45,
  });

  if (primaryScore <= 0 && secondaryScore <= 0 && tokenScore <= 0) {
    return 0;
  }

  return Math.min(
    1,
    Math.max(
      primaryScore,
      secondaryScore * 0.82,
      tokenScore * 0.7,
      primaryScore * 0.75 + secondaryScore * 0.35 + tokenScore * 0.2,
    ),
  );
}

function buildLexicalTopHits(scoredNodes = [], maxCount = 5) {
  return scoredNodes
    .filter((item) => (Number(item?.lexicalScore) || 0) > 0)
    .sort((a, b) => {
      const lexicalDelta =
        (Number(b?.lexicalScore) || 0) - (Number(a?.lexicalScore) || 0);
      if (lexicalDelta !== 0) return lexicalDelta;
      return (Number(b?.finalScore) || 0) - (Number(a?.finalScore) || 0);
    })
    .slice(0, Math.max(1, maxCount))
    .map((item) => ({
      nodeId: item.nodeId,
      type: item.node?.type || "",
      label:
        item.node?.fields?.name ||
        item.node?.fields?.title ||
        item.node?.fields?.summary ||
        item.nodeId,
      lexicalScore: Math.round((Number(item.lexicalScore) || 0) * 1000) / 1000,
      finalScore: Math.round((Number(item.finalScore) || 0) * 1000) / 1000,
    }));
}

function buildVisibilityTopHits(scoredNodes = [], maxCount = 6) {
  return scoredNodes
    .filter((item) => Number(item?.knowledgeVisibilityScore) > 0)
    .sort((a, b) => {
      const visibilityDelta =
        (Number(b?.knowledgeVisibilityScore) || 0) -
        (Number(a?.knowledgeVisibilityScore) || 0);
      if (visibilityDelta !== 0) return visibilityDelta;
      return (Number(b?.weightedScore) || 0) - (Number(a?.weightedScore) || 0);
    })
    .slice(0, Math.max(1, maxCount))
    .map((item) => ({
      nodeId: item.nodeId,
      type: item.node?.type || "",
      label:
        item.node?.fields?.name ||
        item.node?.fields?.title ||
        item.node?.fields?.summary ||
        item.nodeId,
      visibilityScore:
        Math.round((Number(item.knowledgeVisibilityScore) || 0) * 1000) / 1000,
      knowledgeMode: String(item.knowledgeMode || ""),
    }));
}

function pickActiveRegion(graph, optionValue = "") {
  const direct = String(optionValue || "").trim();
  if (direct) return direct;

  const historyRegion = String(
    graph?.historyState?.activeRegion || graph?.historyState?.lastExtractedRegion || "",
  ).trim();
  if (historyRegion) return historyRegion;

  const fallback = getActiveNodes(graph)
    .filter((node) => !node.archived)
    .sort((a, b) => (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0))
    .find((node) => getScopeRegionKey(node?.scope));

  return String(getScopeRegionKey(fallback?.scope) || "").trim();
}

function buildScopeBucketWeightMap(options = {}) {
  return {
    [MEMORY_SCOPE_BUCKETS.CHARACTER_POV]: Number(
      options.recallCharacterPovWeight ?? 1.25,
    ),
    [MEMORY_SCOPE_BUCKETS.USER_POV]: Number(options.recallUserPovWeight ?? 1.05),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION]: Number(
      options.recallObjectiveCurrentRegionWeight ?? 1.15,
    ),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION]: Number(
      options.recallObjectiveAdjacentRegionWeight ?? 0.9,
    ),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL]: Number(
      options.recallObjectiveGlobalWeight ?? 0.75,
    ),
    [MEMORY_SCOPE_BUCKETS.OTHER_POV]: 0.6,
  };
}

function createEmptyScopeBucketMap() {
  return {
    [MEMORY_SCOPE_BUCKETS.CHARACTER_POV]: [],
    [MEMORY_SCOPE_BUCKETS.USER_POV]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL]: [],
  };
}

function createEmptyTemporalBucketMap() {
  return {
    [STORY_TEMPORAL_BUCKETS.CURRENT]: [],
    [STORY_TEMPORAL_BUCKETS.ADJACENT_PAST]: [],
    [STORY_TEMPORAL_BUCKETS.DISTANT_PAST]: [],
    [STORY_TEMPORAL_BUCKETS.FLASHBACK]: [],
    [STORY_TEMPORAL_BUCKETS.FUTURE]: [],
    [STORY_TEMPORAL_BUCKETS.UNDATED]: [],
  };
}

function pushScopeBucketDebug(map, bucket, value) {
  if (!Object.prototype.hasOwnProperty.call(map, bucket)) {
    map[bucket] = [];
  }
  map[bucket].push(value);
}

function getScopeBucketPriority(bucket) {
  switch (bucket) {
    case MEMORY_SCOPE_BUCKETS.CHARACTER_POV:
      return 5;
    case MEMORY_SCOPE_BUCKETS.USER_POV:
      return 4;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION:
      return 3;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION:
      return 2;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL:
      return 1;
    default:
      return 0;
  }
}

function getTemporalBucketPriority(bucket) {
  switch (bucket) {
    case STORY_TEMPORAL_BUCKETS.CURRENT:
      return 5;
    case STORY_TEMPORAL_BUCKETS.ADJACENT_PAST:
      return 4;
    case STORY_TEMPORAL_BUCKETS.UNDATED:
      return 3;
    case STORY_TEMPORAL_BUCKETS.FLASHBACK:
      return 2;
    case STORY_TEMPORAL_BUCKETS.DISTANT_PAST:
      return 1;
    case STORY_TEMPORAL_BUCKETS.FUTURE:
      return 0;
    default:
      return 0;
  }
}

function normalizeTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeOwnerKeyList(ownerKeys = []) {
  return [
    ...new Set(
      (Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys])
        .map((value) => normalizeTrimmedString(value))
        .filter(Boolean),
    ),
  ];
}

function roundOwnerScore(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function buildCharacterOwnerCatalog(graph) {
  return (listKnowledgeOwners(graph) || [])
    .filter((entry) => String(entry?.ownerType || "") === "character")
    .map((entry) => ({
      ownerKey: normalizeTrimmedString(entry.ownerKey),
      ownerName: normalizeTrimmedString(entry.ownerName),
      nodeId: normalizeTrimmedString(entry.nodeId),
      aliases: [
        ...new Set(
          [entry.ownerName, ...(entry.aliases || [])]
            .map((value) => normalizeTrimmedString(value))
            .filter(Boolean),
        ),
      ],
      updatedAt: Number(entry?.updatedAt || 0),
    }))
    .filter((entry) => entry.ownerKey && entry.ownerName);
}

function createSceneOwnerCandidateMap() {
  return new Map();
}

function addSceneOwnerCandidate(
  candidateMap,
  owner,
  { score = 0, source = "", reason = "" } = {},
) {
  if (!(candidateMap instanceof Map)) return;
  const ownerKey = normalizeTrimmedString(owner?.ownerKey);
  const ownerName = normalizeTrimmedString(owner?.ownerName);
  if (!ownerKey || !ownerName) return;

  const existing = candidateMap.get(ownerKey) || {
    ownerKey,
    ownerName,
    ownerType: "character",
    nodeId: normalizeTrimmedString(owner?.nodeId),
    aliases: [
      ...new Set(
        [ownerName, ...(owner?.aliases || [])]
          .map((value) => normalizeTrimmedString(value))
          .filter(Boolean),
      ),
    ],
    score: 0,
    sources: [],
    reasons: [],
  };

  existing.score += Math.max(0, Number(score) || 0);
  if (source && !existing.sources.includes(source)) {
    existing.sources.push(source);
  }
  if (reason && !existing.reasons.includes(reason)) {
    existing.reasons.push(reason);
  }
  candidateMap.set(ownerKey, existing);
}

function finalizeSceneOwnerCandidates(candidateMap, maxCount = 8) {
  if (!(candidateMap instanceof Map)) return [];
  return [...candidateMap.values()]
    .map((entry) => ({
      ...entry,
      score: roundOwnerScore(entry.score),
      aliases: [...new Set((entry.aliases || []).filter(Boolean))],
      sources: [...new Set((entry.sources || []).filter(Boolean))],
      reasons: [...new Set((entry.reasons || []).filter(Boolean))],
    }))
    .sort((left, right) => {
      const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(left.ownerName || "").localeCompare(
        String(right.ownerName || ""),
        "zh-Hans-CN",
      );
    })
    .slice(0, Math.max(1, maxCount));
}

function resolveLegacySceneOwner(graph, rawOwnerName = "") {
  const ownerName = normalizeTrimmedString(rawOwnerName);
  if (!ownerName) return null;
  const ownerCatalog = buildCharacterOwnerCatalog(graph);
  const matchedOwners = ownerCatalog.filter(
    (owner) =>
      String(owner.ownerName || "").trim() === ownerName &&
      String(owner.nodeId || "").trim(),
  );
  if (matchedOwners.length !== 1) {
    return null;
  }
  const resolved = resolveKnowledgeOwner(graph, {
    ownerType: "character",
    ownerName,
  });
  return resolved?.ownerKey ? resolved : null;
}

function collectOwnerCandidatesFromText(
  ownerCatalog,
  texts = [],
  { score = 0.8, source = "recent-message" } = {},
) {
  const candidateMap = createSceneOwnerCandidateMap();
  const normalizedTexts = (Array.isArray(texts) ? texts : [texts])
    .map((value) => normalizeQueryText(value, 800).toLowerCase())
    .filter(Boolean);
  if (normalizedTexts.length === 0) {
    return [];
  }

  for (const owner of ownerCatalog || []) {
    const alias = [...(owner.aliases || [])]
      .map((value) => normalizeTrimmedString(value))
      .filter((value) => value.length >= 2)
      .sort((left, right) => right.length - left.length)
      .find((value) =>
        normalizedTexts.some((text) => text.includes(value.toLowerCase())),
      );
    if (!alias) continue;
    addSceneOwnerCandidate(candidateMap, owner, {
      score,
      source,
      reason: `Văn bản trực tiếp gọi tên ${alias}`,
    });
  }

  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function collectOwnerCandidatesFromNodes(
  graph,
  ownerCatalog,
  nodeEntries = [],
) {
  const candidateMap = createSceneOwnerCandidateMap();

  for (const entry of Array.isArray(nodeEntries) ? nodeEntries : []) {
    const node = entry?.node || entry;
    const baseScore = Math.max(0, Number(entry?.weightedScore ?? entry?.finalScore ?? 0) || 0);
    if (!node || node.archived) continue;

    if (node.type === "pov_memory" && String(node?.scope?.ownerType || "") === "character") {
      const resolvedOwner = resolveKnowledgeOwner(graph, {
        ownerType: "character",
        ownerName: node?.scope?.ownerName || node?.scope?.ownerId,
      });
      if (resolvedOwner.ownerKey) {
        addSceneOwnerCandidate(candidateMap, resolvedOwner, {
          score: 1.0 + Math.min(0.8, baseScore / 8),
          source: "candidate-pov-owner",
          reason: `ứng viên POV khớp trúng ${resolvedOwner.ownerName || resolvedOwner.ownerKey}`,
        });
      }
      continue;
    }

    const text = [
      node?.fields?.participants,
      node?.fields?.summary,
      node?.fields?.state,
      node?.fields?.title,
      node?.fields?.name,
      node?.fields?.status,
    ]
      .filter((value) => value != null)
      .join(" ");
    if (!text) continue;

    const matched = collectOwnerCandidatesFromText(ownerCatalog, [text], {
      score: 0.9 + Math.min(0.6, baseScore / 10),
      source: "objective-participant",
    });
    for (const owner of matched) {
      addSceneOwnerCandidate(candidateMap, owner, {
        score: owner.score,
        source: "objective-participant",
        reason: owner.reasons?.[0] || "Nút khách quan điểm cao có nhắc tới nhân vật này",
      });
    }
  }

  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function collectRecentActiveOwnerCandidates(
  graph,
  ownerCatalog,
  limit = 4,
) {
  const sorted = [...(ownerCatalog || [])].sort((left, right) => {
    const updatedDelta = Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    if (updatedDelta !== 0) return updatedDelta;
    const leftNode = left.nodeId ? getNode(graph, left.nodeId) : null;
    const rightNode = right.nodeId ? getNode(graph, right.nodeId) : null;
    return (Number(rightNode?.seqRange?.[1] ?? rightNode?.seq ?? 0) || 0)
      - (Number(leftNode?.seqRange?.[1] ?? leftNode?.seq ?? 0) || 0);
  });
  return sorted.slice(0, Math.max(1, limit)).map((owner) => ({
    ...owner,
    score: 0.35,
    sources: ["recent-active"],
    reasons: ["Nhân vật hoạt động gần đây"],
  }));
}

function mergeSceneOwnerCandidateLists(...lists) {
  const candidateMap = createSceneOwnerCandidateMap();
  for (const list of lists) {
    for (const owner of Array.isArray(list) ? list : []) {
      addSceneOwnerCandidate(candidateMap, owner, {
        score: owner.score,
        source: Array.isArray(owner.sources) ? owner.sources[0] || "" : "",
        reason: Array.isArray(owner.reasons) ? owner.reasons[0] || "" : "",
      });
      for (const source of Array.isArray(owner.sources) ? owner.sources : []) {
        addSceneOwnerCandidate(candidateMap, owner, {
          score: 0,
          source,
          reason: "",
        });
      }
      for (const reason of Array.isArray(owner.reasons) ? owner.reasons : []) {
        addSceneOwnerCandidate(candidateMap, owner, {
          score: 0,
          source: "",
          reason,
        });
      }
    }
  }
  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function resolveSceneOwnersHeuristically(
  sceneOwnerCandidates = [],
  { mode = "heuristic", maxOwners = 4, minScore = 0.55 } = {},
) {
  const filtered = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .filter(
      (candidate) =>
        candidate?.ownerKey && Number(candidate?.score || 0) >= Number(minScore || 0),
    )
    .slice(0, Math.max(1, maxOwners));
  return {
    ownerKeys: filtered.map((candidate) => candidate.ownerKey),
    ownerScores: Object.fromEntries(
      filtered.map((candidate) => [
        candidate.ownerKey,
        roundOwnerScore(Math.min(1, Number(candidate.score || 0))),
      ]),
    ),
    mode: filtered.length > 0 ? mode : "unresolved",
  };
}

function getSceneOwnerNamesByKeys(sceneOwnerCandidates = [], ownerKeys = []) {
  const keySet = new Set(normalizeOwnerKeyList(ownerKeys));
  if (keySet.size === 0) return [];
  return (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .filter((candidate) => keySet.has(candidate.ownerKey))
    .map((candidate) => candidate.ownerName)
    .filter(Boolean);
}

function buildSceneOwnerCandidateText(sceneOwnerCandidates = []) {
  const candidates = Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [];
  if (candidates.length === 0) {
    return "(Hiện không có ứng viên nhân vật cụ thể nào đủ tin cậy; nếu không thể phán định thì hãy trả về mảng rỗng)";
  }
  return candidates
    .map((candidate) => {
      const reasonText = Array.isArray(candidate.reasons) && candidate.reasons.length
        ? candidate.reasons.join("；")
        : "Không";
      return `- ownerKey=${candidate.ownerKey}; ownerName=${candidate.ownerName}; score=${roundOwnerScore(candidate.score).toFixed(3)}; reasons=${reasonText}`;
    })
    .join("\n");
}

function resolveSceneOwnerKeyFromValue(sceneOwnerCandidates = [], value = "") {
  const normalizedValue = normalizeTrimmedString(value);
  if (!normalizedValue) return "";
  const directMatch = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .find((candidate) => candidate.ownerKey === normalizedValue);
  if (directMatch?.ownerKey) {
    return directMatch.ownerKey;
  }
  const lowered = normalizedValue.toLowerCase();
  const aliasMatch = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .find((candidate) =>
      [candidate.ownerName, ...(candidate.aliases || [])]
        .map((item) => normalizeTrimmedString(item).toLowerCase())
        .includes(lowered),
    );
  return aliasMatch?.ownerKey || "";
}

function normalizeLlmSceneOwnerScores(
  sceneOwnerCandidates = [],
  rawScores = [],
) {
  const normalizedEntries = Array.isArray(rawScores)
    ? rawScores
    : rawScores && typeof rawScores === "object"
      ? Object.entries(rawScores).map(([ownerKey, score]) => ({
          ownerKey,
          score,
          reason: "",
        }))
      : [];
  const result = [];
  for (const entry of normalizedEntries) {
    const ownerKey = resolveSceneOwnerKeyFromValue(
      sceneOwnerCandidates,
      entry?.ownerKey || entry?.owner || entry?.owner_name || "",
    );
    if (!ownerKey) continue;
    result.push({
      ownerKey,
      score: clampRange(entry?.score, 0, 0, 1),
      reason: normalizeTrimmedString(entry?.reason),
    });
  }
  return result;
}

function buildSelectedByOwner(
  graph,
  selectedNodes = [],
  scoredNodes = [],
  sceneOwnerCandidates = [],
) {
  const scoredMap = new Map(
    (Array.isArray(scoredNodes) ? scoredNodes : []).map((item) => [item.nodeId, item]),
  );
  const result = {};
  for (const node of Array.isArray(selectedNodes) ? selectedNodes : []) {
    if (!node?.id) continue;
    const scored = scoredMap.get(node.id);
    const ownerKeys = normalizeOwnerKeyList([
      resolveKnowledgeOwnerKeyFromScope(graph, node?.scope),
      ...(scored?.knowledgeVisibleOwnerKeys || []),
    ])
      .map((ownerKey) => resolveSceneOwnerKeyFromValue(sceneOwnerCandidates, ownerKey) || ownerKey)
      .filter(Boolean);
    for (const ownerKey of ownerKeys) {
      result[ownerKey] ||= [];
      result[ownerKey].push(node.id);
    }
  }
  return result;
}

function augmentSelectedNodeIdsWithActiveOwnerPov(
  graph,
  selectedNodeIds = [],
  scoredNodes = [],
  activeOwnerKeys = [],
  limit = 8,
) {
  const ownerKeys = normalizeOwnerKeyList(activeOwnerKeys);
  if (ownerKeys.length === 0) {
    return uniqueNodeIds(selectedNodeIds).slice(0, Math.max(1, limit));
  }

  const selectedSet = new Set(uniqueNodeIds(selectedNodeIds));
  const ownerPovNodeIds = [];
  for (const ownerKey of ownerKeys) {
    const bestPov = (Array.isArray(scoredNodes) ? scoredNodes : []).find((item) => {
      if (!item?.node || item.node.archived || item.node.type !== "pov_memory") {
        return false;
      }
      const scopeOwnerKey = resolveKnowledgeOwnerKeyFromScope(graph, item.node.scope);
      return scopeOwnerKey === ownerKey;
    });
    if (!bestPov?.nodeId || selectedSet.has(bestPov.nodeId)) continue;
    selectedSet.add(bestPov.nodeId);
    ownerPovNodeIds.push(bestPov.nodeId);
  }

  return uniqueNodeIds([
    ...ownerPovNodeIds,
    ...selectedNodeIds,
  ]).slice(0, Math.max(1, limit));
}

function buildRecallSceneOwnerAugmentPrompt(maxNodes, sceneOwnerCandidateText = "") {
  return [
    "Ngoài selected_keys, bạn còn phải đồng thời phán định những nhân vật cụ thể thật sự tham gia vào phản hồi hiện tại của cảnh này.",
    `Tối đa trả về ${Math.max(1, Math.min(4, Number(maxNodes) || 4))} active_owner_keys; nếu không thể phán định đáng tin cậy thì có thể trả về mảng rỗng.`,
    "active_owner_keys bắt buộc phải chọn từ các ownerKey ứng viên đã cho, đừng dùng tên thẻ nhân vật để thay cho nhân vật cụ thể.",
    "active_owner_scores bắt buộc phải là mảng, mỗi mục có định dạng {\"ownerKey\":\"...\",\"score\":0.0,\"reason\":\"...\"}, score nằm trong khoảng 0..1.",
    "selected_keys chỉ được chọn từ các khóa ngắn ứng viên hiện tại; nếu không chọn mục nào thì hệ thống sẽ lùi về truy hồi theo điểm số.",
    "Nếu một sự thật khách quan chỉ được một phần nhân vật biết thì vẫn phải giữ nguyên phán định của những nhân vật cụ thể đó, đừng trộn mọi người thành một nhân vật tổng quát.",
    "",
    "## Ứng viên nhân vật trong cảnh",
    sceneOwnerCandidateText || "(Không)",
  ].join("\n");
}

/**
 * Pipeline truy xuất trộn ba tầng
 *
 * @param {object} params
 * @param {object} params.graph - trạng thái đồ thị hiện tại
 * @param {string} params.userMessage - Người dùngđầu vào
 * @param {string[]} params.recentMessages - nội dung hội thoại của vài lượt gần nhất
 * @param {object} params.embeddingConfig - Embedding Cấu hình API
 * @param {object[]} params.schema - nútLoại Schema
 * @param {object} [params.options] - truy xuấttùy chọn
 * @returns {Promise<RetrievalResult>}
 */
export async function retrieve({
  graph,
  userMessage,
  recentMessages = [],
  embeddingConfig,
  schema,
  signal = undefined,
  options = {},
  settings = {},
  onStreamProgress = null,
}) {
  throwIfAborted(signal);
  const startedAt = nowMs();
  const topK = clampPositiveInt(options.topK, 20);
  const maxRecallNodes = clampPositiveInt(options.maxRecallNodes, 8);
  const enableLLMRecall = options.enableLLMRecall ?? true;
  const enableVectorPrefilter = options.enableVectorPrefilter ?? true;
  const enableGraphDiffusion = options.enableGraphDiffusion ?? true;
  const diffusionTopK = clampPositiveInt(options.diffusionTopK, 100);
  const llmCandidatePool = clampPositiveInt(options.llmCandidatePool, 30);
  const weights = options.weights ?? {};
  const enableVisibility = options.enableVisibility ?? false;
  const visibilityFilter = options.visibilityFilter ?? null;
  const enableCrossRecall = options.enableCrossRecall ?? false;
  const enableProbRecall = options.enableProbRecall ?? false;
  const probRecallChance = options.probRecallChance ?? 0.15;
  const enableMultiIntent = options.enableMultiIntent ?? true;
  const multiIntentMaxSegments = clampPositiveInt(
    options.multiIntentMaxSegments,
    4,
  );
  const teleportAlpha = clampRange(options.teleportAlpha, 0.15);
  const enableTemporalLinks = options.enableTemporalLinks ?? true;
  const temporalLinkStrength = clampRange(
    options.temporalLinkStrength,
    0.2,
  );
  const enableDiversitySampling = options.enableDiversitySampling ?? true;
  const dppCandidateMultiplier = clampPositiveInt(
    options.dppCandidateMultiplier,
    3,
  );
  const dppQualityWeight = clampRange(
    options.dppQualityWeight,
    1.0,
    0,
    10,
  );
  const enableCooccurrenceBoost = options.enableCooccurrenceBoost ?? false;
  const cooccurrenceScale = clampRange(
    options.cooccurrenceScale,
    0.1,
    0,
    10,
  );
  const cooccurrenceMaxNeighbors = clampPositiveInt(
    options.cooccurrenceMaxNeighbors,
    10,
  );
  const enableResidualRecall = options.enableResidualRecall ?? false;
  const residualBasisMaxNodes = clampPositiveInt(
    options.residualBasisMaxNodes,
    24,
    2,
  );
  const residualNmfTopics = clampPositiveInt(options.residualNmfTopics, 15);
  const residualNmfNoveltyThreshold = clampRange(
    options.residualNmfNoveltyThreshold,
    0.4,
  );
  const residualThreshold = clampRange(
    options.residualThreshold,
    0.3,
    0,
    10,
  );
  const residualTopK = clampPositiveInt(options.residualTopK, 5);
  const enableContextQueryBlend = options.enableContextQueryBlend ?? true;
  const contextAssistantWeight = clampRange(
    options.contextAssistantWeight,
    0.2,
    0,
    1,
  );
  const contextPreviousUserWeight = clampRange(
    options.contextPreviousUserWeight,
    0.1,
    0,
    1,
  );
  const enableLexicalBoost = options.enableLexicalBoost ?? true;
  const lexicalWeight = clampRange(options.lexicalWeight, 0.18, 0, 10);
  const enableScopedMemory = options.enableScopedMemory ?? true;
  const enablePovMemory = options.enablePovMemory ?? true;
  const enableRegionScopedObjective =
    options.enableRegionScopedObjective ?? true;
  const enableCognitiveMemory = options.enableCognitiveMemory ?? true;
  const enableSpatialAdjacency = options.enableSpatialAdjacency ?? true;
  const injectLowConfidenceObjectiveMemory =
    options.injectLowConfidenceObjectiveMemory ?? false;
  const injectUserPovMemory = options.injectUserPovMemory ?? true;
  const injectObjectiveGlobalMemory = options.injectObjectiveGlobalMemory ?? true;
  const enableStoryTimeline = options.enableStoryTimeline ?? true;
  const injectStoryTimeLabel = options.injectStoryTimeLabel ?? true;
  const storyTimeSoftDirecting = options.storyTimeSoftDirecting ?? true;
  const stPromptContext = getSTContextForPrompt();
  const ownerCatalog = buildCharacterOwnerCatalog(graph);
  const legacyOwnerCandidate =
    resolveLegacySceneOwner(graph, options.activeCharacterPovOwner) ||
    resolveLegacySceneOwner(graph, graph?.historyState?.activeCharacterPovOwner) ||
    resolveLegacySceneOwner(graph, stPromptContext?.charName);
  const activeCharacterPovOwner = String(
    legacyOwnerCandidate?.ownerName || "",
  ).trim();
  const activeUserPovOwner = String(
    options.activeUserPovOwner ||
      graph?.historyState?.activeUserPovOwner ||
      stPromptContext?.userName ||
      "",
  ).trim();
  const preliminarySceneOwnerCandidates = mergeSceneOwnerCandidateLists(
    legacyOwnerCandidate
      ? [
          {
            ...legacyOwnerCandidate,
            score: 0.6,
            sources: ["legacy-unique-match"],
            reasons: ["Ánh xạ duy nhất tới nhân vật cụ thể trong đồ thị"],
          },
        ]
      : [],
    collectOwnerCandidatesFromText(ownerCatalog, [
      userMessage,
      ...recentMessages,
    ]),
    collectRecentActiveOwnerCandidates(graph, ownerCatalog),
  );
  const preliminarySceneOwnerResolution = resolveSceneOwnersHeuristically(
    preliminarySceneOwnerCandidates,
    {
      mode: "heuristic",
      maxOwners: 4,
      minScore: 0.55,
    },
  );
  let activeRecallOwnerKeys = normalizeOwnerKeyList(
    options.activeRecallOwnerKeys ||
      preliminarySceneOwnerResolution.ownerKeys ||
      [],
  );
  let activeRecallOwnerScores = {
    ...(preliminarySceneOwnerResolution.ownerScores || {}),
  };
  let sceneOwnerResolutionMode = activeRecallOwnerKeys.length
    ? preliminarySceneOwnerResolution.mode || "heuristic"
    : "unresolved";
  const activeRegionContext = resolveActiveRegionContext(
    graph,
    options.activeRegion || "",
  );
  const activeRegion = activeRegionContext.activeRegion || pickActiveRegion(graph, options.activeRegion);
  const adjacentRegionContext = enableSpatialAdjacency
    ? resolveAdjacentRegions(graph, activeRegion)
    : { adjacentRegions: [] };
  const storyCueMode = enableStoryTimeline
    ? resolveStoryCueMode(userMessage, recentMessages)
    : "";
  const activeStoryContext = enableStoryTimeline
    ? resolveActiveStoryContext(graph, {
        segmentId: options.activeStorySegmentId || "",
        label: options.activeStoryTimeLabel || "",
      })
    : {
        activeSegmentId: "",
        activeStoryTimeLabel: "",
        source: "",
        segment: null,
        resolved: false,
      };
  const bucketWeights = buildScopeBucketWeightMap(options);

  let activeNodes = getActiveNodes(graph).filter(
    (node) =>
      !node.archived &&
      Array.isArray(node.seqRange) &&
      Number.isFinite(node.seqRange[1]),
  );

  if (enableVisibility && visibilityFilter) {
    activeNodes = filterByVisibility(activeNodes, visibilityFilter);
  }

  const nodeCount = activeNodes.length;
  const normalizedTopK = Math.max(1, topK);
  const normalizedMaxRecallNodes = Math.max(1, maxRecallNodes);
  const normalizedDiffusionTopK = Math.max(1, diffusionTopK);
  const normalizedLlmCandidatePool = Math.max(
    normalizedMaxRecallNodes,
    llmCandidatePool,
  );
  const retrievalMeta = createRetrievalMeta(enableLLMRecall);
  retrievalMeta.activeRegion = activeRegion;
  retrievalMeta.activeRegionSource = activeRegionContext.source || "";
  retrievalMeta.activeStorySegmentId = activeStoryContext.activeSegmentId || "";
  retrievalMeta.activeStoryTimeLabel = activeStoryContext.activeStoryTimeLabel || "";
  retrievalMeta.activeStoryTimeSource = activeStoryContext.source || "";
  retrievalMeta.activeCharacterPovOwner =
    activeCharacterPovOwner ||
    preliminarySceneOwnerCandidates[0]?.ownerName ||
    "";
  retrievalMeta.activeUserPovOwner = activeUserPovOwner;
  retrievalMeta.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
  retrievalMeta.activeRecallOwnerKeys = [...activeRecallOwnerKeys];
  retrievalMeta.activeRecallOwnerScores = { ...activeRecallOwnerScores };
  retrievalMeta.sceneOwnerResolutionMode = sceneOwnerResolutionMode;
  retrievalMeta.sceneOwnerCandidates = preliminarySceneOwnerCandidates.map((candidate) => ({
    ownerKey: candidate.ownerKey,
    ownerName: candidate.ownerName,
    score: roundOwnerScore(candidate.score),
    sources: [...(candidate.sources || [])],
    reasons: [...(candidate.reasons || [])],
  }));
  retrievalMeta.bucketWeights = { ...bucketWeights };
  retrievalMeta.temporalBuckets = createEmptyTemporalBucketMap();
  retrievalMeta.knowledgeGateMode = enableCognitiveMemory
    ? "anchored-soft-visibility"
    : "disabled";
  debugLog(
    `[ST-BME] Bắt đầu truy xuất: ${nodeCount} nút hoạt động${enableVisibility ? " (Biên nhận thức đã bật)" : ""}`,
  );

  let vectorResults = [];
  let diffusionResults = [];
  let llmMeta = { ...retrievalMeta.llm };
  const exactEntityAnchors = [];
  let supplementalAnchorNodeIds = [];

  if (nodeCount === 0) {
    return buildResult(graph, [], schema, {
      retrieval: {
        ...retrievalMeta,
        llm: {
          ...llmMeta,
          status: enableLLMRecall ? "skipped" : "disabled",
          reason: "Hiện không có nút hoạt động nào có thể tham gia truy hồi",
        },
        timings: {
          total: roundMs(nowMs() - startedAt),
        },
      },
      scopeContext: {
        enableScopedMemory,
        enablePovMemory,
        enableRegionScopedObjective,
        enableCognitiveMemory,
        enableStoryTimeline,
        injectUserPovMemory,
        injectObjectiveGlobalMemory,
        activeRegion,
        activeRegionSource: activeRegionContext.source || "",
        activeStorySegmentId: activeStoryContext.activeSegmentId || "",
        activeStoryTimeLabel: activeStoryContext.activeStoryTimeLabel || "",
        activeStoryTimeSource: activeStoryContext.source || "",
        injectStoryTimeLabel,
        activeCharacterPovOwner,
        activeUserPovOwner,
        activeCharacterPovOwners: preliminarySceneOwnerCandidates.map(
          (candidate) => candidate.ownerName,
        ),
        activeRecallOwnerKey: activeRecallOwnerKeys[0] || "",
        activeRecallOwnerKeys: [...activeRecallOwnerKeys],
        activeRecallOwnerScores: { ...activeRecallOwnerScores },
        sceneOwnerResolutionMode,
        sceneOwnerCandidates: retrievalMeta.sceneOwnerCandidates,
        adjacentRegions: adjacentRegionContext.adjacentRegions,
        injectLowConfidenceObjectiveMemory,
        graph,
        bucketWeights,
      },
    });
  }
  const sharedRanking = await rankNodesForTaskContext({
    graph,
    userMessage,
    recentMessages,
    embeddingConfig,
    signal,
    options: {
      topK: normalizedTopK,
      diffusionTopK: normalizedDiffusionTopK,
      enableVectorPrefilter,
      enableGraphDiffusion,
      enableContextQueryBlend,
      enableMultiIntent,
      multiIntentMaxSegments,
      contextAssistantWeight,
      contextPreviousUserWeight,
      teleportAlpha,
      enableTemporalLinks,
      temporalLinkStrength,
      enableLexicalBoost,
      lexicalWeight,
      weights,
      activeNodes,
    },
  });
  const contextQueryBlend = sharedRanking.contextQueryBlend;
  const lexicalQuery = sharedRanking.lexicalQuery;
  retrievalMeta.queryBlendActive = Boolean(
    sharedRanking?.diagnostics?.queryBlendActive,
  );
  retrievalMeta.queryBlendParts = Array.isArray(
    sharedRanking?.diagnostics?.queryBlendParts,
  )
    ? [...sharedRanking.diagnostics.queryBlendParts]
    : [];
  retrievalMeta.queryBlendWeights = {
    ...(sharedRanking?.diagnostics?.queryBlendWeights || {}),
  };
  retrievalMeta.segmentsUsed = Array.isArray(sharedRanking?.diagnostics?.segmentsUsed)
    ? [...sharedRanking.diagnostics.segmentsUsed]
    : [];
  retrievalMeta.vectorHits = Number(sharedRanking?.diagnostics?.vectorHits || 0);
  retrievalMeta.vectorMergedHits = Number(
    sharedRanking?.diagnostics?.vectorMergedHits || 0,
  );
  retrievalMeta.seedCount = Number(sharedRanking?.diagnostics?.seedCount || 0);
  retrievalMeta.diffusionHits = Number(
    sharedRanking?.diagnostics?.diffusionHits || 0,
  );
  retrievalMeta.lexicalBoostedNodes = Number(
    sharedRanking?.diagnostics?.lexicalBoostedNodes || 0,
  );
  retrievalMeta.temporalSyntheticEdgeCount = Number(
    sharedRanking?.diagnostics?.temporalSyntheticEdgeCount || 0,
  );
  retrievalMeta.teleportAlpha = Number(
    sharedRanking?.diagnostics?.teleportAlpha || teleportAlpha,
  );
  retrievalMeta.lexicalTopHits = Array.isArray(
    sharedRanking?.diagnostics?.lexicalTopHits,
  )
    ? [...sharedRanking.diagnostics.lexicalTopHits]
    : [];
  retrievalMeta.timings.vector = Number(
    sharedRanking?.diagnostics?.timings?.vector || 0,
  );
  retrievalMeta.timings.diffusion = Number(
    sharedRanking?.diagnostics?.timings?.diffusion || 0,
  );
  for (const reason of sharedRanking?.diagnostics?.skipReasons || []) {
    pushSkipReason(retrievalMeta, reason);
  }
  vectorResults = Array.isArray(sharedRanking?.vectorResults)
    ? [...sharedRanking.vectorResults]
    : [];
  diffusionResults = Array.isArray(sharedRanking?.diffusionResults)
    ? [...sharedRanking.diffusionResults]
    : [];
  exactEntityAnchors.push(...(sharedRanking?.exactEntityAnchors || []));
  supplementalAnchorNodeIds = collectSupplementalAnchorNodeIds(
    graph,
    vectorResults,
    exactEntityAnchors.map((item) => item.nodeId),
    5,
  );

  let residualResult = {
    triggered: false,
    hits: [],
    skipReason: "",
  };
  const residualStartedAt = nowMs();
  if (enableResidualRecall) {
    const basisNodes = buildResidualBasisNodes(
      graph,
      exactEntityAnchors,
      vectorResults,
      residualBasisMaxNodes,
    );
    residualResult = await runResidualRecall({
      queryText: contextQueryBlend.combinedText || userMessage,
      graph,
      embeddingConfig,
      basisNodes,
      candidateNodes: activeNodes,
      basisLimit: residualBasisMaxNodes,
      nTopics: residualNmfTopics,
      noveltyThreshold: residualNmfNoveltyThreshold,
      residualThreshold,
      residualTopK,
      signal,
    });
    retrievalMeta.residualTriggered = Boolean(residualResult.triggered);
    retrievalMeta.residualHits = residualResult.hits?.length || 0;
    pushSkipReason(retrievalMeta, residualResult.skipReason);
  }
  retrievalMeta.timings.residual = roundMs(nowMs() - residualStartedAt);

  const diffusionStartedAt = nowMs();
  if (enableGraphDiffusion && (enableCrossRecall || residualResult.triggered)) {
    debugLog("[ST-BME] Tầng 2: khuếch tán đồ thị PEDSA");
    const seeds = [
      ...vectorResults.map((v) => ({ id: v.nodeId, energy: v.score })),
      ...exactEntityAnchors.map((item) => ({ id: item.nodeId, energy: 2.0 })),
      ...(residualResult.hits || []).map((item) => ({
        id: item.nodeId,
        energy: item.score,
      })),
    ];

    if (enableCrossRecall && exactEntityAnchors.length > 0) {
      for (const anchor of exactEntityAnchors) {
        const connectedEdges = getNodeEdges(graph, anchor.nodeId);
        for (const edge of connectedEdges) {
          if (edge.invalidAt) continue;
          const neighborId =
            edge.fromId === anchor.nodeId ? edge.toId : edge.fromId;
          const neighbor = getNode(graph, neighborId);
          if (neighbor && !neighbor.archived && neighbor.type === "event") {
            seeds.push({ id: neighborId, energy: 1.5 * edge.strength });
          }
        }
      }
    }

    const seedMap = new Map();
    for (const s of seeds) {
      const existing = seedMap.get(s.id) || 0;
      if (s.energy > existing) seedMap.set(s.id, s.energy);
    }
    const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({
      id,
      energy,
    }));
    retrievalMeta.seedCount = uniqueSeeds.length;

    if (uniqueSeeds.length > 0) {
      const adjacencyMap = buildTemporalAdjacencyMap(graph, {
        includeTemporalLinks: enableTemporalLinks,
        temporalLinkStrength,
      });
      retrievalMeta.temporalSyntheticEdgeCount =
        Number(adjacencyMap.syntheticEdgeCount) || 0;
      retrievalMeta.teleportAlpha = teleportAlpha;
      diffusionResults = diffuseAndRank(adjacencyMap, uniqueSeeds, {
        maxSteps: 2,
        decayFactor: 0.6,
        topK: normalizedDiffusionTopK,
        teleportAlpha,
      }).filter((item) => {
        const node = getNode(graph, item.nodeId);
        return node && !node.archived;
      });
    }
    retrievalMeta.diffusionHits = diffusionResults.length;
  }
  if (enableGraphDiffusion && (enableCrossRecall || residualResult.triggered)) {
    retrievalMeta.timings.diffusion = roundMs(nowMs() - diffusionStartedAt);
  }

  debugLog("[ST-BME] Tầng 3: chấm điểm hỗn hợp");

  const scoreMap = new Map();

  for (const v of vectorResults) {
    const entry = scoreMap.get(v.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.vectorScore = v.score;
    scoreMap.set(v.nodeId, entry);
  }

  for (const d of diffusionResults) {
    const entry = scoreMap.get(d.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.graphScore = d.energy;
    scoreMap.set(d.nodeId, entry);
  }

  if (scoreMap.size === 0) {
    for (const node of activeNodes) {
      if (!scoreMap.has(node.id)) {
        scoreMap.set(node.id, { graphScore: 0, vectorScore: 0 });
      }
    }
  }

  const cooccurrenceStartedAt = nowMs();
  if (enableCooccurrenceBoost) {
    const anchorWeights = new Map();
    for (const anchor of exactEntityAnchors) {
      anchorWeights.set(anchor.nodeId, 2.0);
    }
    for (const nodeId of supplementalAnchorNodeIds) {
      const fallbackWeight =
        scoreMap.get(nodeId)?.vectorScore ||
        scoreMap.get(nodeId)?.graphScore ||
        0.5;
      anchorWeights.set(
        nodeId,
        Math.max(anchorWeights.get(nodeId) || 0, fallbackWeight),
      );
    }

    if (anchorWeights.size > 0) {
      const cooccurrenceIndex = createCooccurrenceIndex(graph, {
        maxAnchorsPerBatch: 10,
        eligibleNodes: activeNodes.filter(isEligibleAnchorNode),
      });
      const graphScores = new Map(
        [...scoreMap.entries()].map(([nodeId, value]) => [
          nodeId,
          value.graphScore || 0,
        ]),
      );
      const boosted = applyCooccurrenceBoost(
        graphScores,
        anchorWeights,
        cooccurrenceIndex,
        {
          scale: cooccurrenceScale,
          maxNeighbors: cooccurrenceMaxNeighbors,
        },
      );
      retrievalMeta.cooccurrenceBoostedNodes = boosted.boostedNodes.length;

      for (const [nodeId, boostedScore] of boosted.scores.entries()) {
        const entry = scoreMap.get(nodeId) || { graphScore: 0, vectorScore: 0 };
        entry.graphScore = boostedScore;
        scoreMap.set(nodeId, entry);
      }
      if (boosted.boostedNodes.length === 0) {
        pushSkipReason(retrievalMeta, "cooccurrence-no-neighbors");
      }
    } else {
      pushSkipReason(retrievalMeta, "cooccurrence-no-anchor");
    }
  }
  retrievalMeta.timings.cooccurrence = roundMs(nowMs() - cooccurrenceStartedAt);

  const scoringStartedAt = nowMs();
  const scoredNodes = [];
  for (const [nodeId, scores] of scoreMap) {
    const node = getNode(graph, nodeId);
    if (!node || node.archived) continue;
    const lexicalScore = enableLexicalBoost
      ? computeLexicalScore(node, lexicalQuery.sources)
      : 0;

    const finalScore = hybridScore(
      {
        graphScore: scores.graphScore,
        vectorScore: scores.vectorScore,
        lexicalScore,
        importance: node.importance,
        createdTime: node.createdTime,
      },
      {
        ...weights,
        lexicalWeight: enableLexicalBoost ? lexicalWeight : 0,
      },
    );
    const scopeBucket = enableScopedMemory
      ? classifyNodeScopeBucket(node, {
          activeCharacterPovOwner,
          activeCharacterPovOwners: activeRecallOwnerKeys.map((ownerKey) =>
            preliminarySceneOwnerCandidates.find(
              (candidate) => candidate.ownerKey === ownerKey,
            )?.ownerName || "",
          ),
          activeUserPovOwner,
          activeRegion,
          adjacentRegions: adjacentRegionContext.adjacentRegions,
          enablePovMemory,
          enableRegionScopedObjective,
          allowImplicitCharacterPovFallback: false,
        })
      : MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
    const temporalDirector = enableStoryTimeline
      ? classifyStoryTemporalBucket(graph, node, {
          activeSegmentId: activeStoryContext.activeSegmentId,
          cueMode: storyCueMode,
        })
      : {
          bucket: STORY_TEMPORAL_BUCKETS.UNDATED,
          weight: 1,
          suppressed: false,
          rescued: false,
          reason: "disabled",
        };
    const knowledgeGate = enableCognitiveMemory
      ? computeKnowledgeGateForNode(
          graph,
          node,
          activeRecallOwnerKeys,
          {
            vectorScore: scores.vectorScore,
            graphScore: scores.graphScore,
            lexicalScore,
            scopeBucket,
            injectLowConfidenceObjectiveMemory,
          },
        )
      : {
          visible: true,
          anchored: false,
          rescued: false,
          suppressed: false,
          suppressedReason: "",
          visibilityScore: 0,
          mode: "disabled",
        };
    if (scopeBucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION) {
      retrievalMeta.adjacentRegionMatches.push(nodeId);
    }
    retrievalMeta.knowledgeVisibleOwnersByNode[nodeId] = [
      ...(knowledgeGate.visibleOwnerKeys || []),
    ];
    retrievalMeta.knowledgeSuppressedOwnersByNode[nodeId] = [
      ...(knowledgeGate.suppressedOwnerKeys || []),
    ];
    if (!knowledgeGate.visible) {
      retrievalMeta.knowledgeSuppressedNodes.push(nodeId);
      if (knowledgeGate.suppressedReason) {
        retrievalMeta.visibilitySuppressedReasons[nodeId] =
          knowledgeGate.suppressedReason;
      }
      continue;
    }
    if (knowledgeGate.anchored) {
      retrievalMeta.knowledgeAnchoredNodes.push(nodeId);
    }
    if (knowledgeGate.rescued) {
      retrievalMeta.knowledgeRescuedNodes.push(nodeId);
    }
    pushScopeBucketDebug(
      retrievalMeta.temporalBuckets,
      temporalDirector.bucket,
      nodeId,
    );
    if (storyTimeSoftDirecting && temporalDirector.suppressed) {
      retrievalMeta.temporalSuppressedNodes.push(nodeId);
      continue;
    }
    if (temporalDirector.rescued) {
      retrievalMeta.temporalRescuedNodes.push(nodeId);
    }
    const scopeWeight = enableScopedMemory
      ? resolveScopeBucketWeight(scopeBucket, bucketWeights)
      : 1;
    const knowledgeWeight = enableCognitiveMemory
      ? knowledgeGate.anchored
        ? 1.18
        : knowledgeGate.rescued
          ? 0.92
          : Math.max(0.35, 0.55 + Number(knowledgeGate.visibilityScore || 0) * 0.6)
      : 1;
    const ownerCoverageWeight = enableCognitiveMemory
      ? 1 + Math.max(0, Number(knowledgeGate.ownerCoverage || 0) - 1 / Math.max(1, activeRecallOwnerKeys.length || 1)) * 0.08
      : 1;
    const temporalWeight =
      enableStoryTimeline && storyTimeSoftDirecting
        ? Number(temporalDirector.weight || 1)
        : 1;
    const weightedScore =
      finalScore *
      scopeWeight *
      knowledgeWeight *
      ownerCoverageWeight *
      temporalWeight;

    scoredNodes.push({
      nodeId,
      node,
      finalScore,
      weightedScore,
      lexicalScore,
      scopeBucket,
      scopeWeight,
      knowledgeMode: knowledgeGate.mode,
      knowledgeVisibilityScore: Number(knowledgeGate.visibilityScore || 0),
      knowledgeWeight,
      knowledgeAnchored: Boolean(knowledgeGate.anchored),
      knowledgeRescued: Boolean(knowledgeGate.rescued),
      knowledgeOwnerCoverage: Number(knowledgeGate.ownerCoverage || 0),
      knowledgeVisibleOwnerKeys: [...(knowledgeGate.visibleOwnerKeys || [])],
      knowledgeSuppressedOwnerKeys: [...(knowledgeGate.suppressedOwnerKeys || [])],
      ownerCoverageWeight,
      storyTimeLabel: describeNodeStoryTime(node),
      temporalBucket: temporalDirector.bucket,
      temporalWeight,
      temporalSuppressed: Boolean(temporalDirector.suppressed),
      temporalRescued: Boolean(temporalDirector.rescued),
      temporalReason: String(temporalDirector.reason || ""),
      ...scores,
    });
    pushScopeBucketDebug(
      retrievalMeta.scopeBuckets,
      scopeBucket,
      nodeId,
    );
  }

  scoredNodes.sort((a, b) => {
    const bucketDelta =
      getScopeBucketPriority(b.scopeBucket) - getScopeBucketPriority(a.scopeBucket);
    if (bucketDelta !== 0) return bucketDelta;
    const temporalDelta =
      getTemporalBucketPriority(b.temporalBucket) -
      getTemporalBucketPriority(a.temporalBucket);
    if (temporalDelta !== 0) return temporalDelta;
    const weightedDelta =
      (Number(b.weightedScore) || 0) - (Number(a.weightedScore) || 0);
    if (weightedDelta !== 0) return weightedDelta;
    return (Number(b.finalScore) || 0) - (Number(a.finalScore) || 0);
  });
  retrievalMeta.scoredCandidates = scoredNodes.length;
  retrievalMeta.lexicalBoostedNodes = scoredNodes.filter(
    (item) => (Number(item.lexicalScore) || 0) > 0,
  ).length;
  retrievalMeta.lexicalTopHits = buildLexicalTopHits(scoredNodes);
  retrievalMeta.visibilityTopHits = buildVisibilityTopHits(scoredNodes);
  retrievalMeta.temporalTopHits = scoredNodes.slice(0, 8).map((item) => ({
    nodeId: item.nodeId,
    bucket: item.temporalBucket,
    weight: Math.round((Number(item.temporalWeight) || 0) * 1000) / 1000,
    label: item.storyTimeLabel || "",
    reason: item.temporalReason || "",
  }));
  const sceneOwnerCandidates = mergeSceneOwnerCandidateLists(
    preliminarySceneOwnerCandidates,
    collectOwnerCandidatesFromNodes(
      graph,
      ownerCatalog,
      scoredNodes.slice(0, Math.max(normalizedLlmCandidatePool, 12)),
    ),
  );
  retrievalMeta.sceneOwnerCandidates = sceneOwnerCandidates.map((candidate) => ({
    ownerKey: candidate.ownerKey,
    ownerName: candidate.ownerName,
    score: roundOwnerScore(candidate.score),
    sources: [...(candidate.sources || [])],
    reasons: [...(candidate.reasons || [])],
  }));
  retrievalMeta.timings.scoring = roundMs(nowMs() - scoringStartedAt);

  let selectedNodeIds;
  let llmCandidates = [];
  const diversityStartedAt = nowMs();
  let llmDurationMs = 0;

  if (enableLLMRecall && nodeCount > 0) {
    debugLog("[ST-BME] Truy hồi chính xác bằng LLM");
    llmCandidates = resolveCandidatePool(
      scoredNodes,
      normalizedLlmCandidatePool,
      dppCandidateMultiplier,
      enableDiversitySampling,
      dppQualityWeight,
      retrievalMeta,
    );
    const llmStartedAt = nowMs();
    const llmResult = await llmRecall(
      userMessage,
      recentMessages,
      llmCandidates,
      graph,
      schema,
      normalizedMaxRecallNodes,
      options.recallPrompt,
      sceneOwnerCandidates,
      activeStoryContext.activeStoryTimeLabel || "",
      settings,
      signal,
      onStreamProgress,
    );
    llmDurationMs = nowMs() - llmStartedAt;
    selectedNodeIds = llmResult.selectedNodeIds;
    const llmOwnerResolution =
      llmResult.activeOwnerKeys?.length > 0
        ? {
            ownerKeys: normalizeOwnerKeyList(llmResult.activeOwnerKeys).slice(0, 4),
            ownerScores: Object.fromEntries(
              normalizeOwnerKeyList(llmResult.activeOwnerKeys)
                .slice(0, 4)
                .map((ownerKey) => [
                  ownerKey,
                  roundOwnerScore(
                    Math.min(
                      1,
                      Number(llmResult.activeOwnerScores?.[ownerKey]) ||
                        Number(
                          sceneOwnerCandidates.find(
                            (candidate) => candidate.ownerKey === ownerKey,
                          )?.score || 0,
                        ),
                    ),
                  ),
                ]),
            ),
            mode: llmResult.sceneOwnerResolutionMode || "llm",
          }
        : resolveSceneOwnersHeuristically(sceneOwnerCandidates, {
            mode: "fallback",
            maxOwners: 4,
            minScore: 0.55,
          });
    activeRecallOwnerKeys = [...llmOwnerResolution.ownerKeys];
    activeRecallOwnerScores = { ...(llmOwnerResolution.ownerScores || {}) };
    sceneOwnerResolutionMode = llmOwnerResolution.mode || "unresolved";
    llmMeta = {
      ...retrievalMeta.llm,
      enabled: true,
      status: llmResult.status,
      reason: llmResult.reason,
      selectionProtocol: llmResult.selectionProtocol || "",
      rawSelectedKeys: Array.isArray(llmResult.rawSelectedKeys)
        ? [...llmResult.rawSelectedKeys]
        : [],
      resolvedSelectedKeys: Array.isArray(llmResult.resolvedSelectedKeys)
        ? [...llmResult.resolvedSelectedKeys]
        : [],
      resolvedSelectedNodeIds: Array.isArray(llmResult.resolvedSelectedNodeIds)
        ? [...llmResult.resolvedSelectedNodeIds]
        : [],
      fallbackReason: llmResult.fallbackReason || "",
      fallbackType: llmResult.fallbackType || "",
      emptySelectionAccepted: llmResult.emptySelectionAccepted === true,
      candidateKeyMapPreview: { ...(llmResult.candidateKeyMapPreview || {}) },
      legacySelectionUsed: llmResult.legacySelectionUsed === true,
      candidatePool: llmCandidates.length,
      selectedSeedCount: llmResult.selectedNodeIds.length,
    };
  } else {
    const selectedCandidates = resolveCandidatePool(
      scoredNodes,
      normalizedTopK,
      dppCandidateMultiplier,
      enableDiversitySampling,
      dppQualityWeight,
      retrievalMeta,
    );
    selectedNodeIds = selectedCandidates.map((item) => item.nodeId);
    const heuristicResolution = resolveSceneOwnersHeuristically(
      sceneOwnerCandidates,
      {
        mode: "heuristic",
        maxOwners: 4,
        minScore: 0.55,
      },
    );
    activeRecallOwnerKeys = [...heuristicResolution.ownerKeys];
    activeRecallOwnerScores = { ...(heuristicResolution.ownerScores || {}) };
    sceneOwnerResolutionMode = heuristicResolution.mode || "unresolved";
    llmMeta = {
      ...retrievalMeta.llm,
      enabled: false,
      status: "disabled",
      reason: "LLM xếp hạng tinh đã tắt, trực tiếp dùng xếp hạng theo điểm",
      candidatePool: 0,
      selectedSeedCount: selectedNodeIds.length,
    };
  }
  retrievalMeta.timings.diversity = roundMs(nowMs() - diversityStartedAt);
  retrievalMeta.timings.llm = roundMs(llmDurationMs);
  retrievalMeta.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
  retrievalMeta.activeRecallOwnerKeys = [...activeRecallOwnerKeys];
  retrievalMeta.activeRecallOwnerScores = { ...activeRecallOwnerScores };
  retrievalMeta.sceneOwnerResolutionMode = sceneOwnerResolutionMode;
  retrievalMeta.activeCharacterPovOwner =
    getSceneOwnerNamesByKeys(sceneOwnerCandidates, activeRecallOwnerKeys)[0] || "";

  selectedNodeIds = augmentSelectedNodeIdsWithActiveOwnerPov(
    graph,
    selectedNodeIds,
    scoredNodes,
    activeRecallOwnerKeys,
    normalizedMaxRecallNodes,
  );
  selectedNodeIds = reconstructSceneNodeIds(
    graph,
    selectedNodeIds,
    normalizedMaxRecallNodes,
  );

  // Tăng cường truy cập
  const selectedNodes = selectedNodeIds
    .map((id) => getNode(graph, id))
    .filter(Boolean);
  retrievalMeta.selectedByBucket = selectedNodes.reduce((acc, node) => {
    const bucket = enableScopedMemory
      ? classifyNodeScopeBucket(node, {
          activeCharacterPovOwner,
          activeCharacterPovOwners: getSceneOwnerNamesByKeys(
            sceneOwnerCandidates,
            activeRecallOwnerKeys,
          ),
          activeUserPovOwner,
          activeRegion,
          adjacentRegions: adjacentRegionContext.adjacentRegions,
          enablePovMemory,
          enableRegionScopedObjective,
          allowImplicitCharacterPovFallback: false,
        })
      : MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
    pushScopeBucketDebug(acc, bucket, node.id);
    return acc;
  }, createEmptyScopeBucketMap());
  retrievalMeta.selectedByKnowledgeState = Object.fromEntries(
    selectedNodes.map((node) => {
      const scored = scoredNodes.find((item) => item.nodeId === node.id);
      return [
        node.id,
        {
          mode: String(scored?.knowledgeMode || "selected"),
          anchored: Boolean(scored?.knowledgeAnchored),
          rescued: Boolean(scored?.knowledgeRescued),
          ownerCoverage:
            Math.round((Number(scored?.knowledgeOwnerCoverage) || 0) * 1000) /
            1000,
          visibilityScore:
            Math.round((Number(scored?.knowledgeVisibilityScore) || 0) * 1000) /
            1000,
          visibleOwners: [...(scored?.knowledgeVisibleOwnerKeys || [])],
          suppressedOwners: [...(scored?.knowledgeSuppressedOwnerKeys || [])],
        },
      ];
    }),
  );
  retrievalMeta.selectedByStoryTime = Object.fromEntries(
    selectedNodes.map((node) => {
      const scored = scoredNodes.find((item) => item.nodeId === node.id);
      return [
        node.id,
        {
          bucket: String(scored?.temporalBucket || STORY_TEMPORAL_BUCKETS.UNDATED),
          weight:
            Math.round((Number(scored?.temporalWeight) || 0) * 1000) / 1000,
          label: String(scored?.storyTimeLabel || ""),
          rescued: Boolean(scored?.temporalRescued),
          reason: String(scored?.temporalReason || ""),
        },
      ];
    }),
  );
  retrievalMeta.selectedByOwner = buildSelectedByOwner(
    graph,
    selectedNodes,
    scoredNodes,
    sceneOwnerCandidates,
  );
  if (graph?.historyState) {
    graph.historyState.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
    if (activeRecallOwnerKeys.length > 0) {
      for (const ownerKey of [...activeRecallOwnerKeys].reverse()) {
        pushRecentRecallOwner(graph.historyState, ownerKey);
      }
    }
  }

  reinforceAccessBatch(selectedNodes);

  debugLog(`[ST-BME] Truy xuất hoàn tất: đã chọn ${selectedNodeIds.length} nút`);

  if (enableProbRecall && probRecallChance > 0) {
    const selectedSet = new Set(selectedNodeIds);
    const probability = Math.max(0.01, Math.min(0.5, probRecallChance));
    const candidates = activeNodes
      .filter(
        (n) =>
          !selectedSet.has(n.id) &&
          n.importance >= 6 &&
          n.type !== "synopsis" &&
          n.type !== "rule",
      )
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 3);
    for (const c of candidates) {
      if (Math.random() < probability) {
        selectedNodeIds.push(c.id);
        debugLog(
          `[ST-BME] Kích hoạt xác suất: ${c.fields?.name || c.fields?.summary || c.id}`,
        );
      }
    }
  }

  selectedNodeIds = uniqueNodeIds(selectedNodeIds).slice(
    0,
    normalizedMaxRecallNodes,
  );
  retrievalMeta.knowledgeAnchoredNodes = uniqueNodeIds(
    retrievalMeta.knowledgeAnchoredNodes,
  );
  retrievalMeta.knowledgeSuppressedNodes = uniqueNodeIds(
    retrievalMeta.knowledgeSuppressedNodes,
  );
  retrievalMeta.knowledgeRescuedNodes = uniqueNodeIds(
    retrievalMeta.knowledgeRescuedNodes,
  );
  retrievalMeta.adjacentRegionMatches = uniqueNodeIds(
    retrievalMeta.adjacentRegionMatches,
  );
  retrievalMeta.temporalSuppressedNodes = uniqueNodeIds(
    retrievalMeta.temporalSuppressedNodes,
  );
  retrievalMeta.temporalRescuedNodes = uniqueNodeIds(
    retrievalMeta.temporalRescuedNodes,
  );
  retrievalMeta.llm = llmMeta;
  retrievalMeta.timings.total = roundMs(nowMs() - startedAt);

  return buildResult(graph, selectedNodeIds, schema, {
    retrieval: {
      ...retrievalMeta,
    },
    scopeContext: {
      enableScopedMemory,
      enablePovMemory,
      enableRegionScopedObjective,
      enableCognitiveMemory,
      enableStoryTimeline,
      injectUserPovMemory,
      injectObjectiveGlobalMemory,
      activeRegion,
      activeRegionSource: activeRegionContext.source || "",
      activeStorySegmentId: activeStoryContext.activeSegmentId || "",
      activeStoryTimeLabel: activeStoryContext.activeStoryTimeLabel || "",
      activeStoryTimeSource: activeStoryContext.source || "",
      injectStoryTimeLabel,
      activeCharacterPovOwner:
        getSceneOwnerNamesByKeys(sceneOwnerCandidates, activeRecallOwnerKeys)[0] ||
        activeCharacterPovOwner,
      activeUserPovOwner,
      activeCharacterPovOwners: getSceneOwnerNamesByKeys(
        sceneOwnerCandidates,
        activeRecallOwnerKeys,
      ),
      activeRecallOwnerKey: activeRecallOwnerKeys[0] || "",
      activeRecallOwnerKeys: [...activeRecallOwnerKeys],
      activeRecallOwnerScores: { ...activeRecallOwnerScores },
      sceneOwnerResolutionMode,
      sceneOwnerCandidates: retrievalMeta.sceneOwnerCandidates,
      adjacentRegions: adjacentRegionContext.adjacentRegions,
      injectLowConfidenceObjectiveMemory,
      graph,
      bucketWeights,
    },
  });
}

function buildResidualBasisNodes(
  graph,
  exactEntityAnchors,
  vectorResults,
  maxNodes = 24,
) {
  const basis = [];
  const seen = new Set();

  for (const anchor of exactEntityAnchors || []) {
    const node = getNode(graph, anchor?.nodeId);
    if (
      !node ||
      seen.has(node.id) ||
      !Array.isArray(node.embedding) ||
      node.embedding.length === 0
    ) {
      continue;
    }
    seen.add(node.id);
    basis.push(node);
    if (basis.length >= maxNodes) return basis;
  }

  for (const result of vectorResults || []) {
    const node = getNode(graph, result?.nodeId);
    if (
      !isEligibleAnchorNode(node) ||
      seen.has(node?.id) ||
      !Array.isArray(node?.embedding) ||
      node.embedding.length === 0
    ) {
      continue;
    }
    seen.add(node.id);
    basis.push(node);
    if (basis.length >= maxNodes) break;
  }

  return basis;
}

function resolveCandidatePool(
  scoredNodes,
  targetCount,
  multiplier,
  enableDiversitySampling,
  qualityWeight,
  retrievalMeta,
) {
  const safeTarget = Math.max(1, targetCount);
  const fallback = scoredNodes.slice(0, Math.min(safeTarget, scoredNodes.length));
  retrievalMeta.candidatePoolBeforeDpp = fallback.length;
  retrievalMeta.candidatePoolAfterDpp = fallback.length;
  retrievalMeta.diversityApplied = false;

  if (!enableDiversitySampling) {
    return fallback;
  }

  const poolLimit = Math.min(
    scoredNodes.length,
    Math.max(safeTarget, safeTarget * Math.max(1, multiplier)),
  );
  const pool = scoredNodes.slice(0, poolLimit);
  retrievalMeta.candidatePoolBeforeDpp = pool.length;

  const diversity = applyDiversitySampling(pool, {
    k: safeTarget,
    qualityWeight,
  });
  retrievalMeta.candidatePoolAfterDpp = diversity.afterCount;
  retrievalMeta.diversityApplied = diversity.applied;
  pushSkipReason(retrievalMeta, diversity.reason);

  return diversity.applied ? diversity.selected : fallback;
}

/**
 * Truy hồi chính xác bằng LLM
 */
async function llmRecall(
  userMessage,
  recentMessages,
  candidates,
  graph,
  schema,
  maxNodes,
  customPrompt,
  sceneOwnerCandidates = [],
  activeStoryTimeLabel = "",
  settings = {},
  signal,
  onStreamProgress = null,
) {
  throwIfAborted(signal);
  const contextStr = recentMessages.join("\n---\n");
  const sectionedContextStr =
    buildRecallSectionedTranscript(recentMessages) || contextStr;
  const sceneOwnerCandidateText = buildSceneOwnerCandidateText(sceneOwnerCandidates);
  const {
    candidateKeyToNodeId,
    candidateKeyToCandidateMeta,
    nodeIdToCandidateKey,
  } = createRecallCandidateKeyMaps(candidates);
  const candidateDescriptions = candidates
    .map((c, index) => {
      const node = c.node;
      const typeDef = schema.find((s) => s.id === node.type);
      const typeLabel = typeDef?.label || node.type;
      const storyTimeLabel = describeNodeStoryTime(node);
      const fieldsStr = Object.entries(node.fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const candidateKey =
        nodeIdToCandidateKey[String(c?.nodeId || node?.id || "").trim()] ||
        `R${index + 1}`;
      return `[${candidateKey}] Loại=${typeLabel}, Phạm vi tác dụng=${describeMemoryScope(node.scope)}, thời gian=${storyTimeLabel || "chưa gắn nhãn"}, bucket thời gian=${String(c.temporalBucket || STORY_TEMPORAL_BUCKETS.UNDATED)}, bucket truy hồi=${describeScopeBucket(c.scopeBucket)}, nhận thức=${String(c.knowledgeMode || "unknown")}, mức thấy được=${(Number(c.knowledgeVisibilityScore) || 0).toFixed(3)}, ${fieldsStr} (điểm=${(c.weightedScore ?? c.finalScore).toFixed(3)})`;
    })
    .join("\n");

  const recallPromptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    recentMessages: sectionedContextStr || "(Không)",
    userMessage,
    candidateNodes: candidateDescriptions,
    candidateText: candidateDescriptions,
    sceneOwnerCandidates: sceneOwnerCandidateText,
    activeStoryTimeLabel,
    graphStats: `candidate_count=${candidates.length}`,
    ...getSTContextForPrompt(),
  });
  const recallRegexInput = { entries: [] };
  const systemPrompt = applyTaskRegex(
    settings,
    "recall",
    "finalPrompt",
    recallPromptBuild.systemPrompt || customPrompt || [
      "Bạn là bộ phân tích truy hồi ký ức.",
      "Hãy dựa trên đầu vào mới nhất của người dùng và ngữ cảnh hội thoại để chọn các nút liên quan nhất từ nhóm ứng viên ký ức.",
      "Bạn cũng cần phán định những nhân vật cụ thể thật sự tham gia vào phản hồi hiện tại ở lượt này và trả về ownerKey của họ.",
      "Ưu tiên giữ tính nhất quán của thời gian cốt truyện, đừng đưa thông tin tương lai vào như thể đó là sự thật khách quan đã xảy ra ở hiện tại.",
      "Ưu tiên chọn: (1) nút trực tiếp liên quan tới cảnh hiện tại, (2) nút giữ tính liên tục nhân quả, (3) nút bối cảnh có ảnh hưởng tiềm tàng.",
      `tối đachọn ${maxNodes}  nút。`,
      "Nút ứng viên được nhận diện bằng khóa ngắn (R1 / R2 / R3 ...), chỉ được chọn từ các khóa ngắn đã cho.",
      "Nếu bạn không chọn mục nào thì hệ thống sẽ tự động lùi về truy hồi theo điểm số.",
      "Đầu ra phải là JSON nghiêm ngặt:",
      '{"selected_keys": ["R1", "R2"], "reason": "R1: mô tả ngắn lý do chọn; R2: mô tả ngắn lý do chọn", "active_owner_keys": ["character:alice"], "active_owner_scores": [{"ownerKey": "character:alice", "score": 0.92, "reason": "Cô ấy có mặt và POV liên quan nhất"}]}',
    ].join("\n"),
    recallRegexInput,
    "system",
  );

  const userPrompt = [
    "## Thời gian cốt truyện hiện tại",
    activeStoryTimeLabel || "(chưa xác định)",
    "",
    "## Gần nhấthội thoạingữ cảnh",
    sectionedContextStr || contextStr || "(Không)",
    "",
    "## Người dùngmới nhấtđầu vào",
    userMessage,
    "",
    "## ứng viênKý ứcnút",
    candidateDescriptions,
    "",
    "## Ứng viên nhân vật trong cảnh",
    sceneOwnerCandidateText,
    "",
    "Hãy chọn các nút liên quan nhất, đồng thời trả về ownerKey của những nhân vật cụ thể thật sự tham gia vào phản hồi hiện tại ở lượt này.",
  ].join("\n");
  const promptPayload = resolveTaskPromptPayload(recallPromptBuild, userPrompt);
  const additionalMessages = Array.isArray(promptPayload.additionalMessages)
    ? [...promptPayload.additionalMessages]
    : [];
  additionalMessages.push({
    role: "system",
    content: buildRecallSceneOwnerAugmentPrompt(
      maxNodes,
      sceneOwnerCandidateText,
    ),
  });

  const llmResult = await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(promptPayload, systemPrompt),
    userPrompt: promptPayload.userPrompt,
    maxRetries: 2,
    signal,
    taskType: "recall",
    debugContext: createTaskLlmDebugContext(
      recallPromptBuild,
      recallRegexInput,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages,
    onStreamProgress,
    maxCompletionTokens: Math.max(512, maxNodes * 160),
    returnFailureDetails: true,
  });
  const result = llmResult?.ok ? llmResult.data : null;
  const activeOwnerKeys = normalizeOwnerKeyList(
    (Array.isArray(result?.active_owner_keys) ? result.active_owner_keys : []).map(
      (value) => resolveSceneOwnerKeyFromValue(sceneOwnerCandidates, value),
    ),
  ).slice(0, 4);
  const activeOwnerScoreEntries = normalizeLlmSceneOwnerScores(
    sceneOwnerCandidates,
    result?.active_owner_scores,
  );
  const activeOwnerScores = Object.fromEntries(
    activeOwnerScoreEntries.map((entry) => [
      entry.ownerKey,
      roundOwnerScore(entry.score),
    ]),
  );

  const hasSelectedKeysField =
    result && Object.prototype.hasOwnProperty.call(result, "selected_keys");
  const hasSelectedIdsField =
    result && Object.prototype.hasOwnProperty.call(result, "selected_ids");
  const rawSelectedKeys = Array.isArray(result?.selected_keys)
    ? normalizeRecallSelectionList(result.selected_keys, maxNodes * 4)
    : [];
  const rawSelectedIds = Array.isArray(result?.selected_ids)
    ? normalizeRecallSelectionList(result.selected_ids, maxNodes * 4)
    : [];
  const selectionProtocol = hasSelectedKeysField
    ? "candidate-keys-v1"
    : hasSelectedIdsField
      ? "legacy-selected-ids"
      : "candidate-keys-v1";
  const legacySelectionUsed =
    !hasSelectedKeysField && hasSelectedIdsField && Array.isArray(result?.selected_ids);

  let resolvedSelectedKeys = [];
  let resolvedSelectedNodeIds = [];
  let fallbackReason = "";
  let fallbackType = "";

  if (hasSelectedKeysField) {
    if (!Array.isArray(result?.selected_keys)) {
      fallbackType = "invalid-candidate";
      fallbackReason = "LLM trả về selected_keys có cấu trúc không hợp lệ, đã lùi về bước chấm điểm và xếp hạng";
    } else if (rawSelectedKeys.length === 0) {
      fallbackType = "empty-selection";
      fallbackReason = "LLM trả về selected_keys rỗng, đã lùi về bước chấm điểm và xếp hạng";
    } else {
      resolvedSelectedKeys = rawSelectedKeys
        .filter((key) => candidateKeyToNodeId[key])
        .slice(0, maxNodes);
      resolvedSelectedNodeIds = uniqueNodeIds(
        resolvedSelectedKeys
          .map((key) => candidateKeyToNodeId[key])
          .filter(Boolean),
      ).slice(0, maxNodes);
    }
  } else if (hasSelectedIdsField) {
    if (!Array.isArray(result?.selected_ids)) {
      fallbackType = "invalid-candidate";
      fallbackReason = "LLM trả về selected_ids có cấu trúc không hợp lệ, đã lùi về bước chấm điểm và xếp hạng";
    } else if (rawSelectedIds.length === 0) {
      fallbackType = "empty-selection";
      fallbackReason = "LLM trả về selected_ids rỗng, đã lùi về bước chấm điểm và xếp hạng";
    } else {
      resolvedSelectedNodeIds = uniqueNodeIds(
        rawSelectedIds.filter((id) => candidates.some((c) => c.nodeId === id)),
      ).slice(0, maxNodes);
      resolvedSelectedKeys = resolvedSelectedNodeIds
        .map((nodeId) => nodeIdToCandidateKey[nodeId])
        .filter(Boolean)
        .slice(0, maxNodes);
    }
  } else if (llmResult?.ok) {
    fallbackType = "invalid-candidate";
    fallbackReason = "LLM trả về cấu trúc JSON không thể nhận diện, đã lùi về bước chấm điểm và xếp hạng";
  }

  if (resolvedSelectedNodeIds.length > 0) {
    return {
      selectedNodeIds: resolvedSelectedNodeIds,
      status: "llm",
      activeOwnerKeys,
      activeOwnerScores,
      sceneOwnerResolutionMode: activeOwnerKeys.length > 0 ? "llm" : "fallback",
      reason:
        selectionProtocol === "legacy-selected-ids"
          ? resolvedSelectedNodeIds.length < rawSelectedIds.length
            ? "LLM trả về selected_ids không hợp lệ hoặc vượt giới hạn ở một phần, đã giữ lại phần kết quả có thể phân tích"
            : "LLM chọn lọc chính đã hoàn tất (legacy selected_ids)"
          : resolvedSelectedNodeIds.length < rawSelectedKeys.length
            ? "LLM trả về selected_keys không hợp lệ hoặc vượt giới hạn ở một phần, đã giữ lại phần kết quả có thể phân tích"
            : "LLM chọn lọc chính đã hoàn tất",
      selectionProtocol,
      rawSelectedKeys,
      resolvedSelectedKeys,
      resolvedSelectedNodeIds,
      legacySelectionUsed,
      emptySelectionAccepted: false,
      candidateKeyMapPreview: candidateKeyToCandidateMeta,
      fallbackReason: "",
    };
  }

  // Khi LLM thất bại thì lùi về xếp hạng thuần theo điểm
  fallbackReason ||= llmResult?.ok
    ? hasSelectedKeysField || hasSelectedIdsField
      ? "Khóa ngắn ứng viên hoặc ID ứng viên mà LLM trả về không thể ánh xạ vào nhóm ứng viên hiện tại, đã lùi về bước chấm điểm và xếp hạng"
      : "LLM trả về cấu trúc JSON không thể nhận diện, đã lùi về bước chấm điểm và xếp hạng"
    : buildRecallFallbackReason(llmResult);
  fallbackType ||= llmResult?.ok
    ? "invalid-candidate"
    : llmResult?.errorType || "unknown";
  return {
    selectedNodeIds: candidates.slice(0, maxNodes).map((c) => c.nodeId),
    status: "fallback",
    activeOwnerKeys: [],
    activeOwnerScores: {},
    sceneOwnerResolutionMode: "fallback",
    reason: fallbackReason,
    fallbackType,
    selectionProtocol,
    rawSelectedKeys,
    resolvedSelectedKeys,
    resolvedSelectedNodeIds,
    legacySelectionUsed,
    emptySelectionAccepted: false,
    candidateKeyMapPreview: candidateKeyToCandidateMeta,
    fallbackReason,
  };
}

// ==================== Hàm hỗ trợ v2 ====================

/**
 * ⑥ Lọc biên nhận thức (lấy cảm hứng từ RoleRAG)
 * Lọc bỏ các nút đã cài visibility nhưng không bao gồm nhân vật hiện tại
 * @param {object[]} nodes
 * @param {string} characterName - hiện tạigóc nhìnTên nhân vật
 * @returns {object[]}
 */
function filterByVisibility(nodes, characterName) {
  if (!characterName || typeof characterName !== "string") return nodes;
  return nodes.filter((node) => {
    if (!node.fields?.visibility) return true;
    if (Array.isArray(node.fields.visibility)) {
      return (
        node.fields.visibility.includes(characterName) ||
        node.fields.visibility.includes("*")
      );
    }
    if (typeof node.fields.visibility === "string") {
      const visibleTo = node.fields.visibility
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return visibleTo.includes(characterName) || visibleTo.includes("*");
    }
    return true;
  });
}

/**
 * xây dựngcuối cùngtruy xuấtKết quả
 * Tách phần tiêm thường trú (Core) và phần tiêm truy hồi (Recall)
 */
function buildResult(graph, selectedNodeIds, schema, meta = {}) {
  const coreNodes = [];
  const recallNodes = [];
  const selectedSet = new Set(uniqueNodeIds(selectedNodeIds));
  const scopeContext = meta.scopeContext || {};
  const compareForResult = compareNodeRecallOrderWithContext(graph, scopeContext);
  const summaryEntries =
    typeof getActiveSummaryEntries === "function"
      ? getActiveSummaryEntries(graph)
      : [];

  // Các nút tiêm thường trú (loại có alwaysInject=true)
  const alwaysInjectTypes = new Set(
    schema.filter((s) => s.alwaysInject).map((s) => s.id),
  );
  if (summaryEntries.length > 0) {
    alwaysInjectTypes.delete("synopsis");
  }

  const activeNodes = getActiveNodes(graph).filter((node) => !node.archived);

  for (const node of activeNodes) {
    if (alwaysInjectTypes.has(node.type)) {
      coreNodes.push(node);
    }
  }

  for (const nodeId of selectedSet) {
    const node = getNode(graph, nodeId);
    if (!node || node.archived) continue;
    if (!alwaysInjectTypes.has(node.type)) {
      recallNodes.push(node);
    }
  }

  coreNodes.sort(compareForResult);
  recallNodes.sort(compareForResult);
  const groupedRecallNodes = groupRecallNodes(recallNodes);
  const selectedNodes = [...selectedSet]
    .map((nodeId) => getNode(graph, nodeId))
    .filter((node) => node && !node.archived)
    .sort(compareForResult);
  const scopeBuckets = buildScopedInjectionBuckets(
    coreNodes,
    selectedNodes,
    scopeContext,
  );

  return {
    summaryEntries,
    coreNodes,
    recallNodes,
    groupedRecallNodes,
    scopeBuckets,
    selectedNodeIds: [...selectedSet],
    meta,
    stats: {
      totalActive: activeNodes.length,
      summaryCount: summaryEntries.length,
      coreCount: coreNodes.length,
      recallCount: recallNodes.length,
      characterPovCount: scopeBuckets.characterPov.length,
      userPovCount: scopeBuckets.userPov.length,
      objectiveCurrentRegionCount: scopeBuckets.objectiveCurrentRegion.length,
      objectiveGlobalCount: scopeBuckets.objectiveGlobal.length,
      episodicCount: groupedRecallNodes.episodic.length,
      stateCount: groupedRecallNodes.state.length,
      reflectiveCount: groupedRecallNodes.reflective.length,
      ruleCount: groupedRecallNodes.rule.length,
    },
  };
}

function buildScopedInjectionBuckets(coreNodes, selectedNodes, scopeContext = {}) {
  const buckets = {
    characterPov: [],
    characterPovByOwner: {},
    characterPovOwnerOrder: [],
    userPov: [],
    objectiveCurrentRegion: [],
    objectiveGlobal: [],
  };
  const activeRecallOwnerKeys = normalizeOwnerKeyList(
    scopeContext.activeRecallOwnerKeys || scopeContext.activeRecallOwnerKey || [],
  );
  const combinedNodes = [
    ...selectedNodes,
    ...coreNodes,
  ];
  const compareForBucket = compareNodeRecallOrderWithContext(
    scopeContext.graph,
    scopeContext,
  );
  const seen = new Set();
  const globalCandidates = [];

  for (const node of combinedNodes) {
    if (!node?.id || seen.has(node.id)) continue;
    seen.add(node.id);
    const bucket = classifyNodeScopeBucket(node, {
      activeCharacterPovOwner: scopeContext.activeCharacterPovOwner,
      activeCharacterPovOwners: scopeContext.activeCharacterPovOwners || [],
      activeUserPovOwner: scopeContext.activeUserPovOwner,
      activeRegion: scopeContext.activeRegion,
      adjacentRegions: scopeContext.adjacentRegions,
      enablePovMemory: scopeContext.enablePovMemory !== false,
      enableRegionScopedObjective:
        scopeContext.enableRegionScopedObjective !== false,
      allowImplicitCharacterPovFallback: false,
    });
    const knowledgeGate =
      scopeContext.enableCognitiveMemory !== false
        ? computeKnowledgeGateForNode(
            scopeContext.graph,
            node,
            activeRecallOwnerKeys,
            {
              scopeBucket: bucket,
              injectLowConfidenceObjectiveMemory:
                scopeContext.injectLowConfidenceObjectiveMemory === true,
            },
          )
        : { visible: true };
    if (!knowledgeGate.visible && String(node?.scope?.layer || "objective") === "objective") {
      continue;
    }

    if (bucket === MEMORY_SCOPE_BUCKETS.CHARACTER_POV) {
      if (scopeContext.sceneOwnerResolutionMode === "unresolved") {
        continue;
      }
      const ownerKey =
        resolveKnowledgeOwnerKeyFromScope(scopeContext.graph, node?.scope) ||
        "";
      if (activeRecallOwnerKeys.length > 0 && !activeRecallOwnerKeys.includes(ownerKey)) {
        continue;
      }
      buckets.characterPov.push(node);
      if (ownerKey) {
        buckets.characterPovByOwner[ownerKey] ||= [];
        buckets.characterPovByOwner[ownerKey].push(node);
        if (!buckets.characterPovOwnerOrder.includes(ownerKey)) {
          buckets.characterPovOwnerOrder.push(ownerKey);
        }
      }
      continue;
    }
    if (bucket === MEMORY_SCOPE_BUCKETS.USER_POV) {
      if (scopeContext.injectUserPovMemory !== false) {
        buckets.userPov.push(node);
      }
      continue;
    }
    if (bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION) {
      buckets.objectiveCurrentRegion.push(node);
      continue;
    }
    if (
      bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION ||
      bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL
    ) {
      globalCandidates.push(node);
    }
  }

  buckets.characterPov.sort(compareForBucket);
  for (const ownerKey of Object.keys(buckets.characterPovByOwner)) {
    buckets.characterPovByOwner[ownerKey].sort(compareForBucket);
  }
  buckets.characterPovOwnerOrder = [
    ...activeRecallOwnerKeys.filter((ownerKey) =>
      buckets.characterPovByOwner[ownerKey]?.length > 0,
    ),
    ...buckets.characterPovOwnerOrder.filter(
      (ownerKey) =>
        !activeRecallOwnerKeys.includes(ownerKey) &&
        buckets.characterPovByOwner[ownerKey]?.length > 0,
    ),
  ];
  buckets.userPov.sort(compareForBucket);
  buckets.objectiveCurrentRegion.sort(compareForBucket);
  const cappedGlobal = (scopeContext.injectObjectiveGlobalMemory === false
    ? []
    : globalCandidates.sort(compareForBucket).slice(0, 6));
  buckets.objectiveGlobal = cappedGlobal;

  return buckets;
}

function reconstructSceneNodeIds(graph, seedNodeIds, limit = 16) {
  const selected = [];
  const seen = new Set();

  function push(nodeId) {
    if (!nodeId || seen.has(nodeId) || selected.length >= limit) return;
    const node = getNode(graph, nodeId);
    if (!node || node.archived) return;
    seen.add(nodeId);
    selected.push(nodeId);
  }

  for (const nodeId of uniqueNodeIds(seedNodeIds)) {
    if (selected.length >= limit) break;
    push(nodeId);
    const node = getNode(graph, nodeId);
    if (!node) continue;

    if (node.type === "event") {
      expandEventScene(graph, node, push);
    } else if (node.type === "pov_memory") {
      const relatedNodes = getNodeEdges(graph, node.id)
        .filter(isUsableSceneEdge)
        .map((e) => (e.fromId === node.id ? e.toId : e.fromId))
        .map((id) => getNode(graph, id))
        .filter(Boolean)
        .sort(compareNodeRecallOrder)
        .slice(0, 2);
      for (const relatedNode of relatedNodes) {
        push(relatedNode.id);
        if (relatedNode.type === "event") {
          expandEventScene(graph, relatedNode, push);
        }
      }
    } else if (node.type === "character" || node.type === "location") {
      const relatedEvents = getNodeEdges(graph, node.id)
        .filter(isUsableSceneEdge)
        .map((e) => (e.fromId === node.id ? e.toId : e.fromId))
        .map((id) => getNode(graph, id))
        .filter((n) => n && !n.archived && n.type === "event")
        .sort(compareNodeRecallOrder)
        .slice(0, 2);
      for (const eventNode of relatedEvents) {
        push(eventNode.id);
        expandEventScene(graph, eventNode, push);
      }
    }
  }

  return selected.slice(0, limit);
}

function expandEventScene(graph, eventNode, push) {
  const edges = getNodeEdges(graph, eventNode.id).filter(isUsableSceneEdge);
  for (const edge of edges) {
    const neighborId = edge.fromId === eventNode.id ? edge.toId : edge.fromId;
    const neighbor = getNode(graph, neighborId);
    if (!neighbor || neighbor.archived) continue;
    if (
      neighbor.type === "character" ||
      neighbor.type === "location" ||
      neighbor.type === "thread" ||
      neighbor.type === "reflection" ||
      neighbor.type === "pov_memory"
    ) {
      push(neighbor.id);
    }
  }

  const adjacentEvents = getTemporalNeighborEvents(
    graph,
    eventNode.seq,
    eventNode.id,
  );
  for (const neighborEvent of adjacentEvents) {
    push(neighborEvent.id);
  }
}

function getTemporalNeighborEvents(graph, seq, excludeId) {
  return getActiveNodes(graph, "event")
    .filter((n) => n.id !== excludeId && !n.archived)
    .sort((a, b) => {
      const distance =
        Math.abs((a.seq || 0) - seq) - Math.abs((b.seq || 0) - seq);
      if (distance !== 0) return distance;
      return (b.seq || 0) - (a.seq || 0);
    })
    .slice(0, 2);
}

function isUsableSceneEdge(edge) {
  return edge && !edge.invalidAt && !edge.expiredAt;
}

function compareNodeRecallOrder(a, b) {
  const aSeq = a?.seqRange?.[1] ?? a?.seq ?? 0;
  const bSeq = b?.seqRange?.[1] ?? b?.seq ?? 0;
  if (bSeq !== aSeq) return bSeq - aSeq;
  return (b.importance || 0) - (a.importance || 0);
}

function compareNodeRecallOrderWithContext(graph, scopeContext = {}) {
  const activeStorySegmentId = String(scopeContext?.activeStorySegmentId || "").trim();
  const enableStoryTimeline = scopeContext?.enableStoryTimeline !== false;
  if (!enableStoryTimeline || !activeStorySegmentId) {
    return compareNodeRecallOrder;
  }
  return (a, b) => {
    const temporalDelta =
      getTemporalBucketPriority(
        classifyStoryTemporalBucket(graph, b, {
          activeSegmentId: activeStorySegmentId,
        }).bucket,
      ) -
      getTemporalBucketPriority(
        classifyStoryTemporalBucket(graph, a, {
          activeSegmentId: activeStorySegmentId,
        }).bucket,
      );
    if (temporalDelta !== 0) return temporalDelta;
    return compareNodeRecallOrder(a, b);
  };
}

function groupRecallNodes(nodes) {
  return {
    state: nodes.filter((n) => n.type === "character" || n.type === "location"),
    episodic: nodes.filter((n) => n.type === "event" || n.type === "thread"),
    reflective: nodes.filter(
      (n) => n.type === "reflection" || n.type === "synopsis",
    ),
    rule: nodes.filter((n) => n.type === "rule"),
    other: nodes.filter(
      (n) =>
        ![
          "character",
          "location",
          "event",
          "thread",
          "reflection",
          "synopsis",
          "rule",
        ].includes(n.type),
    ),
  };
}

function uniqueNodeIds(nodeIds) {
  return [...new Set(nodeIds)];
}

