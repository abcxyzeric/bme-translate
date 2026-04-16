import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadRetrieve(stubs) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const retrieverPath = path.resolve(__dirname, "../retrieval/retriever.js");
  const source = await fs.readFile(retrieverPath, "utf8");
  const transformed = `${source
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace("export async function retrieve", "async function retrieve")}
this.retrieve = retrieve;
`;

  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    debugLog() {},
    ...stubs,
  });
  new vm.Script(transformed).runInContext(context);
  return context.retrieve;
}

function createGraph() {
  const nodes = [
    {
      id: "rule-1",
      type: "rule",
      importance: 9,
      createdTime: 1,
      archived: false,
      fields: { title: "Quy tắc 1" },
      seqRange: [1, 1],
    },
    {
      id: "rule-2",
      type: "rule",
      importance: 7,
      createdTime: 2,
      archived: false,
      fields: { title: "Quy tắc 2" },
      seqRange: [2, 2],
    },
    {
      id: "rule-3",
      type: "rule",
      importance: 3,
      createdTime: 3,
      archived: false,
      fields: { title: "Quy tắc 3" },
      seqRange: [3, 3],
    },
  ];
  return { nodes, edges: [] };
}

function createGraphHelpers(graph) {
  return {
    getActiveNodes(target, type = null) {
      const source = target?.nodes || graph.nodes;
      return source.filter(
        (node) => !node.archived && (!type || node.type === type),
      );
    },
    getNode(target, id) {
      return (target?.nodes || graph.nodes).find((node) => node.id === id) || null;
    },
    getNodeEdges(target, nodeId) {
      return (target?.edges || graph.edges).filter(
        (edge) => edge.fromId === nodeId || edge.toId === nodeId,
      );
    },
    buildTemporalAdjacencyMap() {
      return new Map();
    },
  };
}

function getPromptNodeLabel(node = {}, { maxLength = 32 } = {}) {
  const raw = String(
    node?.fields?.title ||
      node?.fields?.name ||
      node?.fields?.summary ||
      node?.fields?.insight ||
      node?.fields?.belief ||
      node?.id ||
      "—",
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "—";
  if (!Number.isFinite(maxLength) || maxLength < 2 || raw.length <= maxLength) {
    return raw;
  }
  return `${raw.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function createPromptNodeReferenceMap(entries = [], { prefix = "N", buildMeta = null } = {}) {
  const keyToNodeId = {};
  const keyToMeta = {};
  const nodeIdToKey = {};
  const references = [];
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const node = entry?.node || entry || {};
    const nodeId = String(entry?.nodeId || node?.id || "").trim();
    if (!nodeId || nodeIdToKey[nodeId]) continue;
    const key = `${String(prefix || "N").trim() || "N"}${references.length + 1}`;
    keyToNodeId[key] = nodeId;
    nodeIdToKey[nodeId] = key;
    keyToMeta[key] = {
      nodeId,
      type: String(node?.type || ""),
      label: getPromptNodeLabel(node),
      ...((typeof buildMeta === "function"
        ? buildMeta({ entry, node, nodeId, key, index, label: getPromptNodeLabel(node) })
        : {}) || {}),
    };
    references.push({ key, nodeId, node, meta: keyToMeta[key] });
  }
  return {
    keyToNodeId,
    keyToMeta,
    nodeIdToKey,
    references,
  };
}

function normalizeQueryText(value, maxLength = 400) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, Math.max(1, maxLength));
}

function splitIntentSegments(text, { maxSegments = 4, minLength = 1 } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const segments = raw
    .split(/[，,。.；;！!？?\n]+|(?:và|tiện thể|ngoài ra|còn nữa|à mà|sau đó|hơn nữa|và còn|đồng thời)/)
    .map((item) => item.trim())
    .filter((item) => item.length >= minLength);
  return uniqueStrings(segments).slice(0, Math.max(1, maxSegments));
}

function uniqueStrings(values = [], maxLength = 400) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const text = normalizeQueryText(value, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function mergeVectorResults(groups, limit) {
  const merged = new Map();
  let rawHitCount = 0;
  for (const group of groups) {
    for (const item of group) {
      rawHitCount += 1;
      const existing = merged.get(item.nodeId);
      if (!existing || item.score > existing.score) {
        merged.set(item.nodeId, item);
      }
    }
  }
  return {
    rawHitCount,
    results: [...merged.values()].slice(0, limit),
  };
}

function parseContextLine(line = "") {
  const raw = String(line ?? "").trim();
  if (!raw) return null;
  const bracketMatch = raw.match(/^\[(user|assistant)\]\s*:\s*([\s\S]*)$/i);
  if (bracketMatch) {
    const role = String(bracketMatch[1] || "").toLowerCase();
    const text = normalizeQueryText(bracketMatch[2] || "");
    return text ? { role, text } : null;
  }
  const plainMatch = raw.match(/^(user|assistant|Người dùng|trợ lý|ai)\s*[：:]\s*([\s\S]*)$/i);
  if (!plainMatch) return null;
  const roleToken = String(plainMatch[1] || "").toLowerCase();
  const role =
    roleToken === "assistant" || roleToken === "trợ lý" || roleToken === "ai"
      ? "assistant"
      : "user";
  const text = normalizeQueryText(plainMatch[2] || "");
  return text ? { role, text } : null;
}

function buildContextQueryBlend(
  userMessage,
  recentMessages = [],
  {
    enabled = true,
    assistantWeight = 0.2,
    previousUserWeight = 0.1,
    maxTextLength = 400,
  } = {},
) {
  const currentText = normalizeQueryText(userMessage, maxTextLength);
  let assistantText = "";
  let previousUserText = "";
  const parsedMessages = Array.isArray(recentMessages)
    ? recentMessages.map((line) => parseContextLine(line)).filter(Boolean)
    : [];

  for (let index = parsedMessages.length - 1; index >= 0; index -= 1) {
    const item = parsedMessages[index];
    if (!assistantText && item.role === "assistant") {
      assistantText = normalizeQueryText(item.text, maxTextLength);
    }
    if (
      !previousUserText &&
      item.role === "user" &&
      normalizeQueryText(item.text, maxTextLength).toLowerCase() !==
        currentText.toLowerCase()
    ) {
      previousUserText = normalizeQueryText(item.text, maxTextLength);
    }
    if (assistantText && previousUserText) break;
  }

  const currentWeight = Math.max(
    0,
    1 - Number(assistantWeight || 0) - Number(previousUserWeight || 0),
  );
  const rawParts = [
    {
      kind: "currentUser",
      label: "hiện tạiTin nhắn người dùng",
      text: currentText,
      weight: enabled ? currentWeight : 1,
    },
  ];
  if (enabled && assistantText) {
    rawParts.push({
      kind: "assistantContext",
      label: "Gần nhất assistant Phản hồi",
      text: assistantText,
      weight: Number(assistantWeight || 0),
    });
  }
  if (enabled && previousUserText) {
    rawParts.push({
      kind: "previousUser",
      label: "Tin nhắn user trước đó",
      text: previousUserText,
      weight: Number(previousUserWeight || 0),
    });
  }

  const dedupedParts = [];
  const seen = new Set();
  for (const part of rawParts) {
    const text = normalizeQueryText(part.text, maxTextLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    dedupedParts.push({ ...part, text });
  }

  const totalWeight = dedupedParts.reduce(
    (sum, part) => sum + Math.max(0, Number(part.weight) || 0),
    0,
  );
  const parts = dedupedParts.map((part) => ({
    ...part,
    weight:
      totalWeight > 0
        ? Math.round((Math.max(0, Number(part.weight) || 0) / totalWeight) * 1000) /
          1000
        : Math.round((1 / Math.max(1, dedupedParts.length)) * 1000) / 1000,
  }));

  return {
    active: enabled && parts.length > 1,
    parts,
    currentText: currentText || parts[0]?.text || "",
    assistantText,
    previousUserText,
    combinedText:
      parts.length <= 1
        ? parts[0]?.text || ""
        : parts.map((part) => `${part.label}:\n${part.text}`).join("\n\n"),
  };
}

function buildVectorQueryPlan(
  blendPlan,
  { enableMultiIntent = true, maxSegments = 4 } = {},
) {
  const plan = [];
  let currentSegments = [];
  for (const part of blendPlan?.parts || []) {
    let queries = [part.text];
    if (part.kind === "currentUser" && enableMultiIntent) {
      currentSegments = splitIntentSegments(part.text, { maxSegments });
      queries = uniqueStrings([
        part.text,
        ...currentSegments.filter((item) => item !== part.text),
      ]);
    } else {
      queries = uniqueStrings([part.text]);
    }
    plan.push({
      kind: part.kind,
      label: part.label,
      weight: part.weight,
      queries,
    });
  }
  return {
    plan,
    currentSegments,
  };
}

function buildLexicalQuerySources(
  userMessage,
  { enableMultiIntent = true, maxSegments = 4 } = {},
) {
  const currentText = normalizeQueryText(userMessage, 400);
  const segments = enableMultiIntent
    ? splitIntentSegments(currentText, { maxSegments })
    : [];
  return {
    sources: uniqueStrings([currentText, ...segments]),
    segments,
  };
}

function computeLexicalScoreForShared(node, querySources = []) {
  const haystack = String(
    node?.fields?.name || node?.fields?.title || node?.fields?.summary || "",
  ).toLowerCase();
  if (!haystack) return 0;
  for (const sourceText of querySources) {
    const normalizedSource = String(sourceText || "").toLowerCase();
    if (normalizedSource && haystack.includes(normalizedSource.split(/\s+/)[0])) {
      return 1;
    }
  }
  return 0;
}

function extractEntityAnchors(userMessage, activeNodes = []) {
  const anchors = [];
  const seen = new Set();
  for (const node of activeNodes) {
    const candidates = [node?.fields?.name, node?.fields?.title]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 2);
    for (const candidate of candidates) {
      if (!String(userMessage || "").includes(candidate)) continue;
      const key = `${node.id}:${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ nodeId: node.id, entity: candidate });
      break;
    }
  }
  return anchors;
}

async function rankNodesForTaskContext({
  graph,
  userMessage,
  recentMessages = [],
  embeddingConfig,
  options = {},
} = {}) {
  const activeNodes = Array.isArray(options.activeNodes)
    ? options.activeNodes.filter((node) => node && !node.archived)
    : (graph?.nodes || []).filter((node) => node && !node.archived);
  const topK = Math.max(1, Math.floor(Number(options.topK) || 20));
  const diffusionTopK = Math.max(1, Math.floor(Number(options.diffusionTopK) || 100));
  const enableVectorPrefilter = options.enableVectorPrefilter ?? true;
  const enableGraphDiffusion = options.enableGraphDiffusion ?? true;
  const enableContextQueryBlend = options.enableContextQueryBlend ?? true;
  const enableMultiIntent = options.enableMultiIntent ?? true;
  const multiIntentMaxSegments = Math.max(
    1,
    Math.floor(Number(options.multiIntentMaxSegments) || 4),
  );
  const contextQueryBlend = buildContextQueryBlend(userMessage, recentMessages, {
    enabled: enableContextQueryBlend,
    assistantWeight: Number(options.contextAssistantWeight ?? 0.2),
    previousUserWeight: Number(options.contextPreviousUserWeight ?? 0.1),
    maxTextLength: Number(options.maxTextLength || 400),
  });
  const queryPlan = buildVectorQueryPlan(contextQueryBlend, {
    enableMultiIntent,
    maxSegments: multiIntentMaxSegments,
  });
  const lexicalQuery = buildLexicalQuerySources(
    contextQueryBlend.currentText || userMessage,
    {
      enableMultiIntent,
      maxSegments: multiIntentMaxSegments,
    },
  );
  const diagnostics = {
    queryBlendActive: contextQueryBlend.active,
    queryBlendParts: (contextQueryBlend.parts || []).map((part) => ({
      kind: part.kind,
      label: part.label,
      weight: part.weight,
      text: part.text,
      length: part.text.length,
    })),
    queryBlendWeights: Object.fromEntries(
      (contextQueryBlend.parts || []).map((part) => [part.kind, part.weight]),
    ),
    segmentsUsed: [...(queryPlan.currentSegments || [])],
    vectorValidation: { valid: true },
    vectorHits: 0,
    vectorMergedHits: 0,
    seedCount: 0,
    diffusionHits: 0,
    temporalSyntheticEdgeCount: 0,
    teleportAlpha: Number(options.teleportAlpha ?? 0.15) || 0.15,
    lexicalBoostedNodes: 0,
    lexicalTopHits: [],
    skipReasons: [],
    timings: { vector: 0, diffusion: 0 },
  };

  let vectorResults = [];
  if (enableVectorPrefilter) {
    const groups = [];
    for (const part of queryPlan.plan) {
      for (const queryText of part.queries) {
        state.vectorCalls.push({ topK, message: queryText });
        const results = [
          { nodeId: "rule-1", score: 0.9 },
          { nodeId: "rule-2", score: 0.8 },
          { nodeId: "rule-3", score: 0.7 },
        ].map((item) => ({
          ...item,
          score: item.score * Math.max(0, Number(part.weight) || 0),
        }));
        groups.push(results);
      }
    }
    const merged = mergeVectorResults(groups, Math.max(topK * 2, 24));
    diagnostics.vectorHits = merged.rawHitCount;
    diagnostics.vectorMergedHits = merged.results.length;
    vectorResults = merged.results;
  }

  const exactEntityAnchors = extractEntityAnchors(
    contextQueryBlend.currentText || userMessage,
    activeNodes,
  );
  let diffusionResults = [];
  if (enableGraphDiffusion) {
    const seedMap = new Map();
    for (const item of vectorResults) {
      seedMap.set(item.nodeId, Math.max(seedMap.get(item.nodeId) || 0, item.score));
    }
    for (const item of exactEntityAnchors) {
      seedMap.set(item.nodeId, Math.max(seedMap.get(item.nodeId) || 0, 2.0));
    }
    const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({ id, energy }));
    diagnostics.seedCount = uniqueSeeds.length;
    if (uniqueSeeds.length > 0) {
      state.diffusionCalls.push({
        seeds: uniqueSeeds,
        options: {
          maxSteps: 2,
          decayFactor: 0.6,
          topK: diffusionTopK,
          teleportAlpha: diagnostics.teleportAlpha,
        },
      });
      diffusionResults = [
        { nodeId: "rule-2", energy: 1.2 },
        { nodeId: "rule-3", energy: 0.9 },
      ];
    }
  }
  diagnostics.diffusionHits = diffusionResults.length;

  const scoreMap = new Map();
  for (const item of vectorResults) {
    scoreMap.set(item.nodeId, {
      graphScore: scoreMap.get(item.nodeId)?.graphScore || 0,
      vectorScore: item.score,
    });
  }
  for (const item of diffusionResults) {
    scoreMap.set(item.nodeId, {
      graphScore: item.energy,
      vectorScore: scoreMap.get(item.nodeId)?.vectorScore || 0,
    });
  }
  if (scoreMap.size === 0) {
    for (const node of activeNodes) {
      scoreMap.set(node.id, { graphScore: 0, vectorScore: 0 });
    }
  }
  const scoredNodes = [...scoreMap.entries()].map(([nodeId, scores]) => {
    const node = activeNodes.find((item) => item.id === nodeId) || null;
    const lexicalScore = computeLexicalScoreForShared(node, lexicalQuery.sources);
    return {
      nodeId,
      node,
      graphScore: scores.graphScore,
      vectorScore: scores.vectorScore,
      lexicalScore,
      finalScore:
        Number(scores.graphScore || 0) +
        Number(scores.vectorScore || 0) +
        Number(lexicalScore || 0) +
        Number(node?.importance || 0),
      weightedScore:
        Number(scores.graphScore || 0) +
        Number(scores.vectorScore || 0) +
        Number(lexicalScore || 0) +
        Number(node?.importance || 0),
    };
  });
  diagnostics.lexicalBoostedNodes = scoredNodes.filter(
    (item) => (Number(item.lexicalScore) || 0) > 0,
  ).length;
  diagnostics.lexicalTopHits = scoredNodes
    .filter((item) => (Number(item.lexicalScore) || 0) > 0)
    .slice(0, 5)
    .map((item) => ({
      nodeId: item.nodeId,
      label: item.node?.fields?.name || item.node?.fields?.title || item.nodeId,
      lexicalScore: item.lexicalScore,
      finalScore: item.finalScore,
    }));

  return {
    activeNodes,
    contextQueryBlend,
    queryPlan,
    lexicalQuery,
    vectorResults,
    exactEntityAnchors,
    diffusionResults,
    scoredNodes,
    diagnostics,
  };
}

const schema = [{ id: "rule", label: "Quy tắc", alwaysInject: false }];

const state = {
  vectorCalls: [],
  diffusionCalls: [],
  llmCalls: [],
  llmCandidateCount: 0,
  llmResponse: { selected_keys: ["R1", "R2"] },
  llmOptions: [],
};

const graph = createGraph();
const helpers = createGraphHelpers(graph);
const retrieve = await loadRetrieve({
  ...helpers,
  createPromptNodeReferenceMap,
  getPromptNodeLabel,
  rankNodesForTaskContext,
  STORY_TEMPORAL_BUCKETS: {
    CURRENT: "current",
    ADJACENT_PAST: "adjacentPast",
    DISTANT_PAST: "distantPast",
    FLASHBACK: "flashback",
    FUTURE: "future",
    UNDATED: "undated",
  },
  MEMORY_SCOPE_BUCKETS: {
    CHARACTER_POV: "characterPov",
    USER_POV: "userPov",
    OBJECTIVE_CURRENT_REGION: "objectiveCurrentRegion",
    OBJECTIVE_ADJACENT_REGION: "objectiveAdjacentRegion",
    OBJECTIVE_GLOBAL: "objectiveGlobal",
    OTHER_POV: "otherPov",
  },
  normalizeMemoryScope(scope = {}) {
    return {
      layer: scope.layer === "pov" ? "pov" : "objective",
      ownerType: scope.ownerType || "",
      ownerId: scope.ownerId || "",
      ownerName: scope.ownerName || "",
      regionPrimary: scope.regionPrimary || "",
      regionPath: Array.isArray(scope.regionPath) ? scope.regionPath : [],
      regionSecondary: Array.isArray(scope.regionSecondary)
        ? scope.regionSecondary
        : [],
    };
  },
  getScopeRegionKey(scope = {}) {
    return String(scope.regionPrimary || "");
  },
  classifyNodeScopeBucket(node, { activeRegion = "" } = {}) {
    if (node?.scope?.layer === "pov") {
      return node?.scope?.ownerType === "user"
        ? "userPov"
        : "characterPov";
    }
    if (
      activeRegion &&
      String(node?.scope?.regionPrimary || "").trim() === String(activeRegion).trim()
    ) {
      return "objectiveCurrentRegion";
    }
    return "objectiveGlobal";
  },
  resolveScopeBucketWeight(bucket, overrides = {}) {
    return Number(overrides?.[bucket] ?? 1) || 1;
  },
  computeKnowledgeGateForNode(_graph, _node, _ownerKey, options = {}) {
    return {
      visible: true,
      anchored: false,
      rescued: false,
      suppressed: false,
      suppressedReason: "",
      visibilityScore:
        options.scopeBucket === "objectiveCurrentRegion" ? 0.8 : 0.45,
      mode: "soft-visible",
      threshold: 0.4,
    };
  },
  resolveKnowledgeOwner(_graph, input = {}) {
    const ownerType = String(input.ownerType || "").trim();
    const ownerName = String(input.ownerName || input.ownerId || "").trim();
    return {
      ownerType,
      ownerName,
      nodeId: String(input.nodeId || "").trim(),
      aliases: ownerName ? [ownerName] : [],
      ownerKey: ownerType && ownerName ? `${ownerType}:${ownerName}` : "",
    };
  },
  resolveKnowledgeOwnerKeyFromScope(_graph, scope = {}) {
    const ownerType = String(scope.ownerType || "").trim();
    const ownerName = String(scope.ownerName || scope.ownerId || "").trim();
    return ownerType && ownerName ? `${ownerType}:${ownerName}` : "";
  },
  listKnowledgeOwners(targetGraph) {
    return (targetGraph?.nodes || [])
      .filter((node) => node?.type === "character" && !node?.archived)
      .map((node) => ({
        ownerKey: `character:${String(node?.fields?.name || "").trim()}`,
        ownerType: "character",
        ownerName: String(node?.fields?.name || "").trim(),
        nodeId: String(node?.id || "").trim(),
        aliases: [String(node?.fields?.name || "").trim()].filter(Boolean),
        updatedAt: 0,
      }))
      .filter((entry) => entry.ownerKey && entry.ownerName);
  },
  resolveActiveRegionContext(graph, preferredRegion = "") {
    return {
      activeRegion:
        String(preferredRegion || graph?.historyState?.activeRegion || "").trim(),
      source: preferredRegion ? "runtime" : "history",
    };
  },
  resolveAdjacentRegions() {
    return {
      canonicalRegion: "",
      adjacentRegions: [],
    };
  },
  resolveActiveStoryContext(targetGraph, preferred = {}) {
    const preferredLabel = String(preferred?.label || "").trim();
    const preferredSegmentId = String(preferred?.segmentId || "").trim();
    const segments = Array.isArray(targetGraph?.timelineState?.segments)
      ? targetGraph.timelineState.segments
      : [];
    const segment =
      segments.find((item) => item.id === preferredSegmentId) ||
      segments.find((item) => item.label === preferredLabel) ||
      segments.find(
        (item) =>
          item.id === String(targetGraph?.historyState?.activeStorySegmentId || "").trim(),
      ) ||
      null;
    return {
      activeSegmentId: String(
        segment?.id || targetGraph?.historyState?.activeStorySegmentId || "",
      ).trim(),
      activeStoryTimeLabel: String(
        segment?.label || targetGraph?.historyState?.activeStoryTimeLabel || "",
      ).trim(),
      source: segment ? "history" : "",
      segment,
      resolved: Boolean(segment),
    };
  },
  resolveStoryCueMode(userMessage = "", recentMessages = []) {
    const text = [userMessage, ...(Array.isArray(recentMessages) ? recentMessages : [])]
      .map((value) => String(value || ""))
      .join("\n");
    if (/hồi ức|trước đây|Quá khứ/.test(text)) return "flashback";
    if (/về sau|tương lai|kế hoạch|dự tính/.test(text)) return "future";
    return "";
  },
  describeNodeStoryTime(node = {}) {
    return String(node?.storyTime?.label || node?.storyTimeSpan?.startLabel || "").trim();
  },
  classifyStoryTemporalBucket(_graph, node, { activeSegmentId = "", cueMode = "" } = {}) {
    const label = String(node?.storyTime?.label || node?.storyTimeSpan?.startLabel || "").trim();
    if (!label) {
      return {
        bucket: "undated",
        weight: 0.88,
        suppressed: false,
        rescued: false,
        reason: "undated",
      };
    }
    if (label === activeSegmentId || label === "hiện tại") {
      return {
        bucket: "current",
        weight: 1.15,
        suppressed: false,
        rescued: false,
        reason: "current",
      };
    }
    if (label === "kế hoạch tương lai") {
      return {
        bucket: "future",
        weight: cueMode === "future" ? 0.74 : 0.22,
        suppressed: cueMode !== "future",
        rescued: false,
        reason: cueMode === "future" ? "future-cue" : "future-suppressed",
      };
    }
    if (label === "chuyện cũ") {
      return {
        bucket: cueMode === "flashback" ? "flashback" : "distantPast",
        weight: cueMode === "flashback" ? 1.02 : 0.64,
        suppressed: false,
        rescued: cueMode === "flashback",
        reason: cueMode === "flashback" ? "flashback-rescued" : "distant-past",
      };
    }
    return {
      bucket: "adjacentPast",
      weight: 1.0,
      suppressed: false,
      rescued: false,
      reason: "adjacent-past",
    };
  },
  pushRecentRecallOwner(historyState, ownerKey = "") {
    historyState.activeRecallOwnerKey = ownerKey;
    historyState.recentRecallOwnerKeys = ownerKey ? [ownerKey] : [];
  },
  describeMemoryScope(scope = {}) {
    return `${scope.layer || "objective"}:${scope.ownerType || ""}:${scope.regionPrimary || ""}`;
  },
  describeScopeBucket(bucket = "") {
    return String(bucket || "");
  },
  EXTRACTION_CONTEXT_REVIEW_HEADER:
    "--- Dưới đây là phần nhìn lại ngữ cảnh (đã trích xuất), chỉ để hiểu cốt truyện ---",
  RECALL_TARGET_CONTENT_HEADER:
    "--- sau đây là phầnlầncầnTruy hồiKý ứcmới củahội thoạiNội dung ---",
  buildTaskPrompt() {
    return { systemPrompt: "" };
  },
  applyTaskRegex(_settings, _taskType, _stage, text) {
    return text;
  },
  splitIntentSegments(text) {
    if (String(text).includes("và")) {
      return String(text).split("và").map((item) => item.trim());
    }
    return [];
  },
  mergeVectorResults(groups, limit) {
    const merged = new Map();
    let rawHitCount = 0;
    for (const group of groups) {
      for (const item of group) {
        rawHitCount += 1;
        const existing = merged.get(item.nodeId);
        if (!existing || item.score > existing.score) {
          merged.set(item.nodeId, item);
        }
      }
    }
    return {
      rawHitCount,
      results: [...merged.values()].slice(0, limit),
    };
  },
  collectSupplementalAnchorNodeIds() {
    return [];
  },
  isEligibleAnchorNode(node) {
    return Boolean(node?.fields?.title || node?.fields?.name);
  },
  createCooccurrenceIndex() {
    return { map: new Map(), source: "batchJournal", batchCount: 0, pairCount: 0 };
  },
  applyCooccurrenceBoost(baseScores) {
    return { scores: new Map(baseScores), boostedNodes: [] };
  },
  applyDiversitySampling(candidates, { k }) {
    return {
      applied: true,
      reason: "",
      selected: candidates.slice(0, k).reverse(),
      beforeCount: candidates.length,
      afterCount: Math.min(k, candidates.length),
    };
  },
  async runResidualRecall() {
    return { triggered: false, hits: [], skipReason: "residual-disabled-test" };
  },
  hybridScore: ({
    graphScore = 0,
    vectorScore = 0,
    lexicalScore = 0,
    importance = 0,
  }) => graphScore + vectorScore + lexicalScore + importance,
  reinforceAccessBatch() {},
  validateVectorConfig() {
    return { valid: true };
  },
  async findSimilarNodesByText(_graph, message, _embeddingConfig, topK) {
    state.vectorCalls.push({ topK, message });
    return [
      { nodeId: "rule-1", score: 0.9 },
      { nodeId: "rule-2", score: 0.8 },
      { nodeId: "rule-3", score: 0.7 },
    ];
  },
  diffuseAndRank(_adjacencyMap, seeds, options) {
    state.diffusionCalls.push({ seeds, options });
    return [
      { nodeId: "rule-2", energy: 1.2 },
      { nodeId: "rule-3", energy: 0.9 },
    ];
  },
  async callLLMForJSON(params = {}) {
    const { userPrompt = "" } = params;
    state.llmOptions.push({ ...params });
    state.llmCalls.push(userPrompt);
    state.llmCandidateCount = userPrompt
      .split("\n")
      .filter((line) => line.trim().startsWith("[")).length;
    if (params.returnFailureDetails) {
      if (state.llmResponse?.ok === false) {
        return state.llmResponse;
      }
      return {
        ok: true,
        data: state.llmResponse,
        errorType: "",
        failureReason: "",
        attempts: 1,
      };
    }
    return state.llmResponse;
  },
    getSTContextForPrompt() {
      return {};
  },
});

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
const noStageResult = await retrieve({
  graph,
  userMessage: "chỉ xemhiện tạiQuy tắc",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 2,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
  },
});
assert.equal(state.vectorCalls.length, 0);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCalls.length, 0);
assert.deepEqual(Array.from(noStageResult.selectedNodeIds), ["rule-2", "rule-1"]);

state.vectorCalls.length = 0;
await retrieve({
  graph,
  userMessage: "sau đó anh ấy làm gì?",
  recentMessages: [
    "[assistant]: anh ấy đã nhắc tới giới hạn của Quy tắc 2",
    "[user]: chúng ta xem Quy tắc 1 trước",
    "[user]: sau đó anh ấy làm gì?",
  ],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableMultiIntent: false,
    enableContextQueryBlend: true,
  },
});
assert.deepEqual(
  state.vectorCalls.map((item) => item.message),
  ["sau đó anh ấy làm gì?", "anh ấy đã nhắc tới giới hạn của Quy tắc 2", "chúng ta xem Quy tắc 1 trước"],
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmCandidateCount = 0;
state.llmResponse = { selected_keys: ["R1", "R2"] };
const llmPoolResult = await retrieve({
  graph,
  userMessage: "hãy đưa ra kết luận dựa theo quy tắc",
  recentMessages: ["Người dùng: hiện tại nên làm gì?"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.deepEqual(state.vectorCalls, [
  { topK: 4, message: "hãy đưa ra kết luận dựa theo quy tắc" },
  { topK: 4, message: "hiện tại nên làm gì?" },
]);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCandidateCount, 2);
assert.deepEqual(Array.from(llmPoolResult.selectedNodeIds), ["rule-2", "rule-1"]);
assert.equal(llmPoolResult.meta.retrieval.llm.status, "llm");
assert.equal(
  llmPoolResult.meta.retrieval.llm.selectionProtocol,
  "candidate-keys-v1",
);
assert.deepEqual(
  Array.from(llmPoolResult.meta.retrieval.llm.rawSelectedKeys),
  ["R1", "R2"],
);
assert.deepEqual(
  Array.from(llmPoolResult.meta.retrieval.llm.resolvedSelectedNodeIds),
  ["rule-2", "rule-1"],
);
assert.equal(
  llmPoolResult.meta.retrieval.llm.candidateKeyMapPreview?.R1?.nodeId,
  "rule-2",
);
assert.equal(llmPoolResult.meta.retrieval.llm.legacySelectionUsed, false);
assert.equal(llmPoolResult.meta.retrieval.llm.candidatePool, 2);
assert.equal(llmPoolResult.meta.retrieval.vectorMergedHits, 3);
assert.equal(llmPoolResult.meta.retrieval.diversityApplied, true);
assert.equal(llmPoolResult.meta.retrieval.candidatePoolBeforeDpp, 3);
assert.equal(llmPoolResult.meta.retrieval.candidatePoolAfterDpp, 2);
assert.equal(state.llmOptions[0].returnFailureDetails, true);
assert.equal(state.llmOptions[0].maxRetries, 2);
assert.equal(state.llmOptions[0].maxCompletionTokens, 512);
assert.match(String(state.llmCalls[0] || ""), /\[R1\]/);
assert.doesNotMatch(String(state.llmCalls[0] || ""), /\[rule-1\]|\[rule-2\]/);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = {
  selected_keys: ["R2"],
  selected_ids: ["rule-2"],
};
const selectedKeysPriorityResult = await retrieve({
  graph,
  userMessage: "ưu tiên dùng giao thức mới",
  recentMessages: ["Người dùng：Kiểm thử mức ưu tiên selected_keys"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.deepEqual(Array.from(selectedKeysPriorityResult.selectedNodeIds), ["rule-1"]);
assert.equal(
  selectedKeysPriorityResult.meta.retrieval.llm.selectionProtocol,
  "candidate-keys-v1",
);
assert.equal(
  selectedKeysPriorityResult.meta.retrieval.llm.legacySelectionUsed,
  false,
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = { selected_ids: ["rule-1"] };
const legacySelectionResult = await retrieve({
  graph,
  userMessage: "tương thích selected_ids cũ",
  recentMessages: ["Người dùng：Kiểm thử legacy đường đi"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.deepEqual(Array.from(legacySelectionResult.selectedNodeIds), ["rule-1"]);
assert.equal(
  legacySelectionResult.meta.retrieval.llm.selectionProtocol,
  "legacy-selected-ids",
);
assert.equal(
  legacySelectionResult.meta.retrieval.llm.legacySelectionUsed,
  true,
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = { selected_keys: [] };
const emptySelectionFallbackResult = await retrieve({
  graph,
  userMessage: "lần này cố ý để trống",
  recentMessages: ["Người dùng：Kiểm thử fallback khi chọn rỗng"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.equal(emptySelectionFallbackResult.meta.retrieval.llm.status, "fallback");
assert.equal(
  emptySelectionFallbackResult.meta.retrieval.llm.fallbackType,
  "empty-selection",
);
assert.equal(
  emptySelectionFallbackResult.meta.retrieval.llm.emptySelectionAccepted,
  false,
);
assert.deepEqual(
  Array.from(emptySelectionFallbackResult.selectedNodeIds),
  ["rule-2", "rule-1"],
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = { selected_keys: ["R99"] };
const invalidKeyFallbackResult = await retrieve({
  graph,
  userMessage: "lần này đưa key không hợp lệ",
  recentMessages: ["Người dùng：Kiểm thử fallback ứng viên không hợp lệ"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.equal(invalidKeyFallbackResult.meta.retrieval.llm.status, "fallback");
assert.equal(
  invalidKeyFallbackResult.meta.retrieval.llm.fallbackType,
  "invalid-candidate",
);
assert.deepEqual(
  Array.from(invalidKeyFallbackResult.selectedNodeIds),
  ["rule-2", "rule-1"],
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
await retrieve({
  graph,
  userMessage: "Quy tắc 1 và Quy tắc 2 có liên hệ gì",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 3,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: true,
    diffusionTopK: 7,
    enableLLMRecall: false,
    enableMultiIntent: true,
    multiIntentMaxSegments: 4,
    enableTemporalLinks: true,
    temporalLinkStrength: 0.2,
    teleportAlpha: 0.15,
  },
});
assert.equal(state.vectorCalls.length, 3);
assert.deepEqual(
  state.vectorCalls.map((item) => item.topK),
  [3, 3, 3],
);
assert.equal(state.diffusionCalls.length, 1);
assert.equal(state.diffusionCalls[0].options.topK, 7);
assert.equal(state.diffusionCalls[0].options.teleportAlpha, 0.15);
assert.equal(noStageResult.meta.retrieval.llm.status, "disabled");

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = {
  ok: false,
  errorType: "invalid-json",
  failureReason: "đầu ra không phải JSON hợp lệ, hãy trả về đối tượng JSON gọn chặt",
};
const fallbackResult = await retrieve({
  graph,
  userMessage: "LLM lần này sẽ hỏng",
  recentMessages: ["Người dùng: hãy hồi ức quy tắc liên quan"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.equal(fallbackResult.meta.retrieval.llm.status, "fallback");
assert.match(fallbackResult.meta.retrieval.llm.reason, /hợp lệ JSON|Lùi vềđến bước chấm điểm và xếp hạng/);
assert.equal(fallbackResult.meta.retrieval.llm.fallbackType, "invalid-json");

const sceneGraph = {
  nodes: [
    {
      id: "event-1",
      type: "event",
      importance: 10,
      createdTime: 1,
      archived: false,
      fields: { title: "Sự kiện 1" },
      seqRange: [1, 1],
    },
    {
      id: "character-1",
      type: "character",
      importance: 6,
      createdTime: 2,
      archived: false,
      fields: { name: "Alice" },
      seqRange: [1, 1],
    },
    {
      id: "location-1",
      type: "location",
      importance: 5,
      createdTime: 3,
      archived: false,
      fields: { title: "đại sảnh" },
      seqRange: [1, 1],
    },
  ],
  edges: [
    { fromId: "event-1", toId: "character-1", relation: "mentions" },
    { fromId: "event-1", toId: "location-1", relation: "occurs_at" },
  ],
};
const sceneSchema = [
  { id: "event", label: "Sự kiện", alwaysInject: false },
  { id: "character", label: "Nhân vật", alwaysInject: false },
  { id: "location", label: "Địa điểm", alwaysInject: false },
];
const cappedResult = await retrieve({
  graph: sceneGraph,
  userMessage: "chỉ xem cảnh này",
  recentMessages: [],
  embeddingConfig: {},
  schema: sceneSchema,
  options: {
    topK: 3,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableProbRecall: false,
  },
});
assert.equal(cappedResult.selectedNodeIds.length, 1);

const lexicalGraph = {
  nodes: [
    {
      id: "char-1",
      type: "character",
      importance: 1,
      createdTime: 1,
      archived: false,
      fields: { name: "Alice", summary: "thường trúNhân vật" },
      seqRange: [1, 1],
    },
    {
      id: "char-2",
      type: "character",
      importance: 1,
      createdTime: 1,
      archived: false,
      fields: { name: "Bob", summary: "thường trúNhân vật" },
      seqRange: [1, 1],
    },
  ],
  edges: [],
};
const lexicalSchema = [{ id: "character", label: "Nhân vật", alwaysInject: false }];
const lexicalResult = await retrieve({
  graph: lexicalGraph,
  userMessage: "Alice hiện tại thế nào rồi",
  recentMessages: [],
  embeddingConfig: {},
  schema: lexicalSchema,
  options: {
    topK: 2,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableLexicalBoost: true,
  },
});
assert.deepEqual(Array.from(lexicalResult.selectedNodeIds), ["char-1"]);
assert.equal(lexicalResult.meta.retrieval.queryBlendActive, false);
assert.equal(lexicalResult.meta.retrieval.lexicalBoostedNodes, 1);
assert.equal(lexicalResult.meta.retrieval.lexicalTopHits[0]?.nodeId, "char-1");

const scopedGraph = {
  nodes: [
    {
      id: "obj-global",
      type: "event",
      importance: 8,
      createdTime: 1,
      archived: false,
      fields: { title: "Sự kiện vương đô cũ" },
      seqRange: [1, 1],
      scope: { layer: "objective", regionPrimary: "Khu phố cũ" },
    },
    {
      id: "char-pov",
      type: "pov_memory",
      importance: 4,
      createdTime: 2,
      archived: false,
      fields: { summary: "Ailin cảm thấy lối vào Tháp chuông rất đáng ngờ" },
      seqRange: [2, 2],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "Ailin",
        ownerName: "Ailin",
        regionPrimary: "Tháp chuông",
      },
    },
  ],
  edges: [],
  historyState: {
    activeRegion: "Tháp chuông",
    activeCharacterPovOwner: "Ailin",
    activeUserPovOwner: "người chơi",
  },
};
const scopedSchema = [
  { id: "event", label: "Sự kiện", alwaysInject: true },
  { id: "pov_memory", label: "Ký ức chủ quan", alwaysInject: false },
];
const scopedResult = await retrieve({
  graph: scopedGraph,
  userMessage: "Rốt cuộc bên trong Tháp chuông có gì",
  recentMessages: [],
  embeddingConfig: {},
  schema: scopedSchema,
  options: {
    topK: 2,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableScopedMemory: true,
    activeRegion: "Tháp chuông",
    activeCharacterPovOwner: "Ailin",
  },
});
assert.deepEqual(Array.from(scopedResult.selectedNodeIds), ["char-pov"]);
assert.equal(scopedResult.meta.retrieval.activeRegion, "Tháp chuông");
assert.ok(Array.isArray(scopedResult.scopeBuckets.characterPov));
assert.equal(scopedResult.scopeBuckets.characterPov[0]?.id, "char-pov");

const multiOwnerGraph = {
  nodes: [
    {
      id: "char-node-a",
      type: "character",
      importance: 6,
      createdTime: 1,
      archived: false,
      fields: { name: "Ailin" },
      seqRange: [1, 1],
    },
    {
      id: "char-node-b",
      type: "character",
      importance: 6,
      createdTime: 1,
      archived: false,
      fields: { name: "Lucia" },
      seqRange: [1, 1],
    },
    {
      id: "pov-a",
      type: "pov_memory",
      importance: 8,
      createdTime: 2,
      archived: false,
      fields: { summary: "Ailin cảm thấy bên trong Tháp chuông còn có một mật đạo thứ hai" },
      seqRange: [2, 2],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "Ailin",
        ownerName: "Ailin",
      },
    },
    {
      id: "pov-b",
      type: "pov_memory",
      importance: 7,
      createdTime: 3,
      archived: false,
      fields: { summary: "Lucia cho rằng lính canh Tháp chuông đang cố tình câu giờ" },
      seqRange: [3, 3],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "Lucia",
        ownerName: "Lucia",
      },
    },
  ],
  edges: [],
  historyState: {
    activeRegion: "",
    activeCharacterPovOwner: "",
    activeUserPovOwner: "người chơi",
  },
};
const multiOwnerSchema = [
  { id: "character", label: "Nhân vật", alwaysInject: false },
  { id: "pov_memory", label: "Ký ức chủ quan", alwaysInject: false },
];
state.llmResponse = {
  selected_ids: ["pov-a", "pov-b"],
  active_owner_keys: ["character:Ailin", "character:Lucia"],
  active_owner_scores: [
    { ownerKey: "character:Ailin", score: 0.91, reason: "POV của cô ấy khớp trực tiếp với truy vấn hiện tại" },
    { ownerKey: "character:Lucia", score: 0.83, reason: "cô ấy cũng ở cùng cảnh và cung cấp nhận định bổ sung" },
  ],
};
const multiOwnerResult = await retrieve({
  graph: multiOwnerGraph,
  userMessage: "Ailin và Lucia hiện tại mỗi người nhìn nhận chuyện Tháp chuông này thế nào",
  recentMessages: ["[assistant]: họ vừa cùng đi vào đại sảnh Tháp chuông"],
  embeddingConfig: {},
  schema: multiOwnerSchema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 4,
  },
});
assert.equal(
  multiOwnerResult.meta.retrieval.llm.selectionProtocol,
  "legacy-selected-ids",
);
assert.equal(
  multiOwnerResult.meta.retrieval.llm.legacySelectionUsed,
  true,
);
assert.deepEqual(
  Array.from(multiOwnerResult.meta.retrieval.activeRecallOwnerKeys),
  ["character:Ailin", "character:Lucia"],
);
assert.equal(multiOwnerResult.meta.retrieval.sceneOwnerResolutionMode, "llm");
assert.deepEqual(
  Array.from(multiOwnerResult.scopeBuckets.characterPovOwnerOrder),
  ["character:Ailin", "character:Lucia"],
);
assert.equal(
  multiOwnerResult.scopeBuckets.characterPovByOwner["character:Ailin"]?.[0]?.id,
  "pov-a",
);
assert.equal(
  multiOwnerResult.scopeBuckets.characterPovByOwner["character:Lucia"]?.[0]?.id,
  "pov-b",
);
assert.equal(
  multiOwnerResult.meta.retrieval.selectedByOwner["character:Ailin"]?.[0],
  "pov-a",
);

const temporalGraph = {
  nodes: [
    {
      id: "evt-current",
      type: "event",
      importance: 5,
      createdTime: 1,
      archived: false,
      fields: { title: "hiện tạiđiều tra" },
      seqRange: [10, 10],
      storyTime: { label: "hiện tại" },
    },
    {
      id: "evt-past",
      type: "event",
      importance: 6,
      createdTime: 2,
      archived: false,
      fields: { title: "Xung đột cũ" },
      seqRange: [8, 8],
      storyTime: { label: "chuyện cũ" },
    },
    {
      id: "evt-future",
      type: "event",
      importance: 10,
      createdTime: 3,
      archived: false,
      fields: { title: "kế hoạch tương lai" },
      seqRange: [12, 12],
      storyTime: { label: "kế hoạch tương lai", tense: "future" },
    },
  ],
  edges: [],
  historyState: {
    activeStorySegmentId: "hiện tại",
    activeStoryTimeLabel: "hiện tại",
    activeStoryTimeSource: "test",
  },
  timelineState: {
    segments: [
      { id: "hiện tại", label: "hiện tại", order: 2 },
      { id: "chuyện cũ", label: "chuyện cũ", order: 1 },
      { id: "kế hoạch tương lai", label: "kế hoạch tương lai", order: 3 },
    ],
  },
};
const temporalSchema = [{ id: "event", label: "Sự kiện", alwaysInject: false }];
const temporalResult = await retrieve({
  graph: temporalGraph,
  userMessage: "Hiện trường hiện tại ra sao",
  recentMessages: [],
  embeddingConfig: {},
  schema: temporalSchema,
  options: {
    topK: 3,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableStoryTimeline: true,
    storyTimeSoftDirecting: true,
    activeStorySegmentId: "hiện tại",
    activeStoryTimeLabel: "hiện tại",
  },
});
assert.equal(temporalResult.meta.retrieval.activeStorySegmentId, "hiện tại");
assert.equal(temporalResult.meta.retrieval.activeStoryTimeLabel, "hiện tại");
assert.ok(Array.isArray(temporalResult.meta.retrieval.temporalSuppressedNodes));
assert.ok(
  Array.isArray(temporalResult.meta.retrieval.temporalBuckets?.future) ||
    Array.isArray(temporalResult.meta.retrieval.temporalBuckets?.["future"]),
);
assert.ok(
  !Array.from(temporalResult.selectedNodeIds).includes("evt-future"),
);
assert.equal(
  temporalResult.meta.retrieval.temporalTopHits[0]?.nodeId,
  "evt-current",
);

console.log("retrieval-config tests passed");



