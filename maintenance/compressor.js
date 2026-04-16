// ST-BME: phân tầngNénengine
// Các nút vượt ngưỡng sẽ được LLM tóm tắt thành nút nén ở tầng cao hơn

import { debugLog } from "../runtime/debug-logging.js";
import { embedText } from "../vector/embedding.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  getActiveNodes,
  getNode,
} from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  getScopeOwnerKey,
  getScopeRegionKey,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { ensureEventTitle, getNodeDisplayName } from "../graph/node-labels.js";
import {
  deriveStoryTimeSpanFromNodes,
  describeNodeStoryTime,
  normalizeStoryTime,
} from "../graph/story-timeline.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { getSTContextForPrompt } from "../host/st-context.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { buildTaskGraphStats } from "./task-graph-stats.js";
import { isDirectVectorConfig } from "../vector/vector-index.js";

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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

function resolveCompressionWindow(compression = {}, force = false) {
  const fanIn = Number.isFinite(Number(compression?.fanIn))
    ? Math.max(2, Number(compression.fanIn))
    : 2;
  const threshold = force
    ? fanIn
    : Number.isFinite(Number(compression?.threshold))
      ? Math.max(2, Number(compression.threshold))
      : fanIn;
  const keepRecent = force
    ? 0
    : Number.isFinite(Number(compression?.keepRecentLeaves))
      ? Math.max(0, Number(compression.keepRecentLeaves))
      : 0;

  return {
    fanIn,
    threshold,
    keepRecent,
  };
}

function normalizeCompressionFieldValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeCompressionFieldValue(item))
      .filter(Boolean)
      .join("；");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

function buildCompressionRankingQueryText(nodes = [], typeDef = {}) {
  const typeLabel = String(typeDef?.label || typeDef?.id || "nút").trim() || "nút";
  const lines = (Array.isArray(nodes) ? nodes : [])
    .map((node, index) => {
      const fieldsText = Object.entries(node?.fields || {})
        .map(([key, value]) => {
          const normalizedValue = normalizeCompressionFieldValue(value);
          return normalizedValue ? `${key}: ${normalizedValue}` : "";
        })
        .filter(Boolean)
        .join(" | ");
      const storyTimeLabel = describeNodeStoryTime(node);
      return [
        `${typeLabel}#${index + 1}`,
        storyTimeLabel ? `thời gian cốt truyện=${storyTimeLabel}` : "",
        fieldsText,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean);
  return lines.length > 0 ? [`Lô nén ${typeLabel}`, ...lines].join("\n") : "";
}

function buildCompressionFallbackSummary(batch = []) {
  return batch
    .map((node) =>
      normalizeCompressionFieldValue(
        node?.fields?.summary ||
          node?.fields?.title ||
          node?.fields?.name ||
          node?.fields?.insight ||
          getNodeDisplayName(node),
      ),
    )
    .filter(Boolean)
    .slice(0, 6)
    .join("；");
}

function normalizeCompressedFields(summaryResult, typeDef, batch = []) {
  const rawFields =
    summaryResult?.fields &&
    typeof summaryResult.fields === "object" &&
    !Array.isArray(summaryResult.fields)
      ? summaryResult.fields
      : summaryResult && typeof summaryResult === "object" && !Array.isArray(summaryResult)
        ? summaryResult
        : {};
  const columns = Array.isArray(typeDef?.columns) ? typeDef.columns : [];
  const normalized = {};

  for (const column of columns) {
    const key = String(column?.name || "").trim();
    if (!key) continue;
    const normalizedValue = normalizeCompressionFieldValue(rawFields[key]);
    if (normalizedValue) {
      normalized[key] = normalizedValue;
    }
  }

  const fallbackSummary = buildCompressionFallbackSummary(batch);
  if (!normalized.summary && columns.some((column) => column?.name === "summary")) {
    normalized.summary = fallbackSummary || "Thiếu tóm tắt cho lô nén";
  }
  if (!normalized.insight && columns.some((column) => column?.name === "insight")) {
    normalized.insight = fallbackSummary || "Thiếu insight cho lô nén";
  }
  if (!normalized.title && columns.some((column) => column?.name === "title")) {
    const titled = ensureEventTitle({ title: rawFields?.title, summary: normalized.summary });
    normalized.title =
      normalizeCompressionFieldValue(titled?.title) ||
      normalizeCompressionFieldValue(rawFields?.name) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.title) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.name) ||
      "Nénnút";
  }
  if (!normalized.name && columns.some((column) => column?.name === "name")) {
    normalized.name =
      normalizeCompressionFieldValue(rawFields?.title) ||
      normalizeCompressionFieldValue(rawFields?.name) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.name) ||
      "Nénnút";
  }

  return normalized;
}

/**
 * Thực thi nén phân tầng cho loại được chỉ định
 *
 * @param {object} params
 * @param {object} params.graph - trạng thái đồ thị hiện tại
 * @param {object} params.typeDef - định nghĩa loại cần nén
 * @param {object} params.embeddingConfig - Embedding Cấu hình API
 * @param {boolean} [params.force=false] - bỏ qua ngưỡng và cưỡng chế nén
 * @returns {Promise<{created: number, archived: number}>}
 */
export async function compressType({
  graph,
  typeDef,
  embeddingConfig,
  schema = [],
  force = false,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  if (!compression || compression.mode !== "hierarchical") {
    return { created: 0, archived: 0 };
  }
  const maxDepth = Number.isFinite(Number(compression.maxDepth))
    ? Math.max(1, Number(compression.maxDepth))
    : 1;

  let totalCreated = 0;
  let totalArchived = 0;

  // Bắt đầu nén từng tầng từ tầng thấp nhất
  for (let level = 0; level < maxDepth; level++) {
    throwIfAborted(signal);
    const result = await compressLevel({
      graph,
      typeDef,
      level,
      embeddingConfig,
      schema,
      force,
      customPrompt,
      signal,
      settings,
    });

    totalCreated += result.created;
    totalArchived += result.archived;

    // Nếu tầng này không có nén xảy ra thì dừng lại
    if (result.created === 0) break;
  }

  return { created: totalCreated, archived: totalArchived };
}

/**
 * Nén các nút của tầng chỉ định
 */
async function compressLevel({
  graph,
  typeDef,
  level,
  embeddingConfig,
  schema = [],
  force,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  const { fanIn, threshold, keepRecent } = resolveCompressionWindow(
    compression,
    force,
  );
  throwIfAborted(signal);

  // Lấy các nút lá đang hoạt động của tầng này
  const levelNodes = getActiveNodes(graph, typeDef.id)
    .filter((n) => n.level === level)
    .sort((a, b) => a.seq - b.seq);
  let created = 0;
  let archived = 0;

  for (const group of groupCompressionCandidates(levelNodes)) {
    if (force ? group.length < fanIn : group.length <= threshold) {
      continue;
    }

    const compressible = group.slice(0, Math.max(0, group.length - keepRecent));
    if (compressible.length < fanIn) {
      continue;
    }

    for (let i = 0; i < compressible.length; i += fanIn) {
      const batch = compressible.slice(i, i + fanIn);
      if (batch.length < 2) break;

      const summaryResult = await summarizeBatch(
        batch,
        typeDef,
        graph,
        embeddingConfig,
        schema,
        customPrompt,
        signal,
        settings,
      );
      if (!summaryResult) continue;
      const normalizedFields = normalizeCompressedFields(
        summaryResult,
        typeDef,
        batch,
      );
      if (Object.keys(normalizedFields).length === 0) {
        throw new Error(
          `Kết quả nén thiếu fields dùng được, không thể tạo nút ${typeDef?.label || typeDef?.id || "Nén"}`,
        );
      }

      const compressedNode = createNode({
        type: typeDef.id,
        fields: normalizedFields,
        seq: batch[batch.length - 1].seq,
        seqRange: [
          batch[0].seqRange?.[0] ?? batch[0].seq,
          batch[batch.length - 1].seqRange?.[1] ?? batch[batch.length - 1].seq,
        ],
        importance: Math.max(...batch.map((n) => n.importance)),
        scope: normalizeMemoryScope(batch[0]?.scope),
      });

      compressedNode.level = level + 1;
      compressedNode.childIds = batch.map((n) => n.id);
      compressedNode.storyTime = normalizeStoryTime();
      compressedNode.storyTimeSpan = deriveStoryTimeSpanFromNodes(
        graph,
        batch,
        "derived",
      );

      const embeddingText =
        normalizeCompressionFieldValue(
          normalizedFields.summary ||
            normalizedFields.insight ||
            normalizedFields.title ||
            normalizedFields.name,
        ) || "";
      if (isDirectVectorConfig(embeddingConfig) && embeddingText) {
        const vec = await embedText(
          embeddingText,
          embeddingConfig,
          { signal },
        );
        if (vec) compressedNode.embedding = Array.from(vec);
      }

      addNode(graph, compressedNode);
      migrateBatchEdges(graph, batch, compressedNode);
      created++;

      for (const child of batch) {
        child.archived = true;
        child.parentId = compressedNode.id;
        archived++;
      }
    }
  }

  return { created, archived };
}

function groupCompressionCandidates(nodes = []) {
  const groups = new Map();
  for (const node of nodes) {
    const normalizedScope = normalizeMemoryScope(node?.scope);
    const key =
      normalizedScope.layer === "pov"
        ? [
            "pov",
            getScopeOwnerKey(normalizedScope) || "owner:none",
            node.type || "",
          ].join("::")
        : [
            "objective",
            getScopeRegionKey(normalizedScope) || "region:global",
            node.type || "",
          ].join("::");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(node);
  }
  return [...groups.values()].map((group) =>
    group.sort((a, b) => a.seq - b.seq),
  );
}

function inspectCompressibleGroup(group = [], compression = {}, force = false) {
  const { fanIn, threshold, keepRecent } = resolveCompressionWindow(
    compression,
    force,
  );
  if (force ? group.length < fanIn : group.length <= threshold) {
    return null;
  }

  const compressible = group.slice(0, Math.max(0, group.length - keepRecent));
  if (compressible.length < fanIn) {
    return null;
  }

  return {
    candidateCount: compressible.length,
    fanIn,
    threshold,
    keepRecent,
  };
}

export function inspectAutoCompressionCandidates(
  graph,
  schema = [],
  force = false,
) {
  const safeSchema = Array.isArray(schema) ? schema : [];
  for (const typeDef of safeSchema) {
    if (typeDef?.compression?.mode !== "hierarchical") continue;
    const maxDepth = Number.isFinite(Number(typeDef?.compression?.maxDepth))
      ? Math.max(1, Number(typeDef.compression.maxDepth))
      : 1;

    for (let level = 0; level < maxDepth; level++) {
      const levelNodes = getActiveNodes(graph, typeDef.id)
        .filter((node) => Number(node?.level || 0) === level)
        .sort((a, b) => a.seq - b.seq);

      for (const group of groupCompressionCandidates(levelNodes)) {
        const summary = inspectCompressibleGroup(
          group,
          typeDef.compression,
          force,
        );
        if (!summary) continue;
        return {
          hasCandidates: true,
          typeId: String(typeDef.id || ""),
          level,
          candidateCount: summary.candidateCount,
          threshold: summary.threshold,
          fanIn: summary.fanIn,
          keepRecent: summary.keepRecent,
          reason: "",
        };
      }
    }
  }

  return {
    hasCandidates: false,
    typeId: "",
    level: null,
    candidateCount: 0,
    threshold: 0,
    fanIn: 0,
    keepRecent: 0,
    reason: "Đã tới chu kỳ nén tự động, nhưng hiện không có nhóm ứng viên nén nội bộ đạt ngưỡng",
  };
}

function migrateBatchEdges(graph, batch, compressedNode) {
  const batchIds = new Set(batch.map((node) => node.id));

  for (const edge of graph.edges) {
    if (edge.invalidAt || edge.expiredAt) continue;

    const fromInside = batchIds.has(edge.fromId);
    const toInside = batchIds.has(edge.toId);
    if (!fromInside && !toInside) continue;
    if (fromInside && toInside) continue;

    const newFromId = fromInside ? compressedNode.id : edge.fromId;
    const newToId = toInside ? compressedNode.id : edge.toId;

    if (newFromId === newToId) continue;
    if (!getNode(graph, newFromId) || !getNode(graph, newToId)) continue;

    const migratedEdge = createEdge({
      fromId: newFromId,
      toId: newToId,
      relation: edge.relation,
      strength: edge.strength,
      edgeType: edge.edgeType,
      scope: edge.scope,
    });
    migratedEdge.validAt = edge.validAt ?? migratedEdge.validAt;
    migratedEdge.invalidAt = edge.invalidAt ?? migratedEdge.invalidAt;
    migratedEdge.expiredAt = edge.expiredAt ?? migratedEdge.expiredAt;

    addEdge(graph, migratedEdge);
  }
}

/**
 * Gọi LLM để tóm tắt một lô nút
 */
async function summarizeBatch(
  nodes,
  typeDef,
  graph,
  embeddingConfig,
  schema = [],
  customPrompt,
  signal,
  settings = {},
) {
  const nodeDescriptions = nodes
    .map((n, i) => {
      const storyTimeLabel = describeNodeStoryTime(n);
      const fieldsStr = Object.entries(n.fields)
        .filter(([_, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n    ");
      return `nút ${i + 1} [tầng ${n.seq}]${storyTimeLabel ? ` [thời gian cốt truyện ${storyTimeLabel}]` : ""}:\n    ${fieldsStr}`;
    })
    .join("\n\n");

  const instruction =
    typeDef.compression.instruction || "Hãy nén các nút dưới đây thành một bản ghi tinh gọn.";
  const excludedNodeIds = new Set(
    (Array.isArray(nodes) ? nodes : []).map((node) => String(node?.id || "").trim()),
  );
  const compressionGraphStats = await buildTaskGraphStats({
    graph,
    schema: Array.isArray(schema) && schema.length > 0 ? schema : [typeDef],
    userMessage: buildCompressionRankingQueryText(nodes, typeDef),
    recentMessages: [],
    embeddingConfig,
    signal,
    activeNodes: getActiveNodes(graph).filter(
      (node) => !excludedNodeIds.has(String(node?.id || "").trim()),
    ),
    rankingOptions: {
      topK: 12,
      diffusionTopK: 48,
      enableContextQueryBlend: false,
      enableMultiIntent: true,
      maxTextLength: 1200,
    },
    relevantHeading: "Các nút đã có liên quan nhất tới lô nén hiện tại",
  });

  const compressPromptBuild = await buildTaskPrompt(settings, "compress", {
    taskName: "compress",
    nodeContent: nodeDescriptions,
    candidateNodes: nodeDescriptions,
    currentRange: `${nodes[0]?.seq ?? "?"} ~ ${nodes[nodes.length - 1]?.seq ?? "?"}`,
    graphStats: compressionGraphStats.graphStats,
    ...getSTContextForPrompt(),
  });
  const compressRegexInput = { entries: [] };
  const systemPrompt = applyTaskRegex(
    settings,
    "compress",
    "finalPrompt",
    compressPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "Bạn là bộ nén ký ức. Hãy tóm tắt nhiều nút cùng loại thành một nút nén ở tầng cao hơn.",
        instruction,
        "",
        "Đầu ra phải là JSON nghiêm ngặt:",
        `{"fields": {${typeDef.columns.map((c) => `"${c.name}": "..."`).join(", ")}}}`,
        "",
        "Quy tắc：",
        "- Giữ lại thông tin then chốt: quan hệ nhân quả, kết quả không thể đảo ngược, và các manh mối cài cắm chưa được giải quyết",
        "- Loại bỏ nội dung trùng lặp và có mật độ thông tin thấp",
        "- Văn bản sau khi nén phải tinh gọn, mục tiêu khoảng 150 ký tự",
        "- Bắt buộc phải giữ đúng thứ tự thời gian cốt truyện, đừng viết đảo nội dung của các giai đoạn khác nhau",
        "- Đừng viết kế hoạch tương lai như thể đó là sự thật khách quan đã xảy ra",
      ].join("\n"),
    compressRegexInput,
    "system",
  );

  const userPrompt = `Hãy nén ${nodes.length} nút "${typeDef.label}" dưới đây:\n\n${nodeDescriptions}`;
  const promptPayload = resolveTaskPromptPayload(
    compressPromptBuild,
    userPrompt,
  );
  const llmSystemPrompt =
    Array.isArray(promptPayload.promptMessages) &&
    promptPayload.promptMessages.length > 0
      ? String(promptPayload.systemPrompt || "")
      : String(promptPayload.systemPrompt || systemPrompt || "");

  return await callLLMForJSON({
    systemPrompt: llmSystemPrompt,
    userPrompt: promptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType: "compress",
    debugContext: createTaskLlmDebugContext(
      compressPromptBuild,
      compressRegexInput,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
  });
}

/**
 * Thực thi nén cho mọi loại hỗ trợ nén
 *
 * @param {object} graph
 * @param {object[]} schema
 * @param {object} embeddingConfig
 * @param {boolean} [force=false]
 * @returns {Promise<{created: number, archived: number}>}
 */
export async function compressAll(
  graph,
  schema,
  embeddingConfig,
  force = false,
  customPrompt,
  signal,
  settings = {},
) {
  let totalCreated = 0;
  let totalArchived = 0;

  for (const typeDef of schema) {
    throwIfAborted(signal);
    if (typeDef.compression?.mode === "hierarchical") {
      const result = await compressType({
        graph,
        typeDef,
        embeddingConfig,
        schema,
        force,
        customPrompt,
        signal,
        settings,
      });
      totalCreated += result.created;
      totalArchived += result.archived;
    }
  }

  return { created: totalCreated, archived: totalArchived };
}

// ==================== v2: Lãng quên chủ động (lấy cảm hứng từ SleepGate) ====================

/**
 * Chu kỳ dọn sạch lúc ngủ
 * Đánh giá giá trị giữ lại của từng nút, nút nào thấp hơn ngưỡng thì lưu trữ (lãng quên)
 *
 * @param {object} graph - trạng thái đồ thị
 * @param {object} settings - cài đặt có bao gồm forgetThreshold
 * @returns {{forgotten: number}} số nút bị lãng quên ở lượt này
 */
export function sleepCycle(graph, settings) {
  const threshold = settings.forgetThreshold ?? 0.5;
  const nodes = getActiveNodes(graph);
  const now = Date.now();
  let forgotten = 0;

  for (const node of nodes) {
    // Bỏ qua các loại thường trú (những nút quan trọng như synopsis, rule không nên bị lãng quên)
    if (
      node.type === "synopsis" ||
      node.type === "rule" ||
      node.type === "thread"
    )
      continue;
    // Bỏ qua nút có độ quan trọng cao
    if (node.importance >= 8) continue;
    // Bỏ qua các nút vừa mới tạo gần đây (< 1 giờ)
    if (now - node.createdTime < 3600000) continue;

    // Tính toán giá trị giữ lại = importance × recency × (1 + accessFreq)
    const ageHours = (now - node.createdTime) / 3600000;
    const recency = 1 / (1 + Math.log10(1 + ageHours));
    const accessFreq = node.accessCount / Math.max(1, ageHours / 24);
    const retentionValue = (node.importance / 10) * recency * (1 + accessFreq);

    if (retentionValue < threshold) {
      node.archived = true;
      forgotten++;
    }
  }

  if (forgotten > 0) {
    debugLog(`[ST-BME] Lãng quên chủ động: đã lưu trữ ${forgotten} nút giá trị thấp`);
  }

  return { forgotten };
}

