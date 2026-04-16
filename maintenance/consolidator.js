// ST-BME: 统一Hợp nhất ký ức引擎（批量化版）
// Hợp nhất Mem0 精确对照 + A-MEM Ký ức进化为单一阶段
// 批量 embed + 批量查近邻 + 单lần LLM 调用

import { debugLog } from "../runtime/debug-logging.js";
import { embedBatch, searchSimilar } from "../vector/embedding.js";
import { addEdge, createEdge, getActiveNodes, getNode } from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  buildScopeBadgeText,
  canMergeScopedMemories,
  describeMemoryScope,
} from "../graph/memory-scope.js";
import {
  describeNodeStoryTime,
  isStoryTimeCompatible,
} from "../graph/story-timeline.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { getSTContextForPrompt } from "../host/st-context.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { buildTaskGraphStats } from "./task-graph-stats.js";
import {
  buildNodeVectorText,
  findSimilarNodesByText,
  isDirectVectorConfig,
  validateVectorConfig,
} from "../vector/vector-index.js";

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

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

/**
 * 统一Hợp nhất ký ức系统提示词（支持批量输出）
 */
const CONSOLIDATION_SYSTEM_PROMPT = `你是一个Hợp nhất ký ức分析器。当新Ký ức加入知识đồ thị时，你需要同时Hoàn tất两项Tác vụ：

**Tác vụ一：冲突检测**
判断新Ký ức与Gần nhất邻的已有Ký ức是否冲突或重复：
- skip: 新Ký ức与已有Ký ức完全重复，应丢弃
- merge: 新Ký ức是对旧Ký ức的修正或补充，应合并
- keep: 新Ký ức是全新信息，应保留

**Tác vụ二：进化分析**（仅当 action=keep 时需要）
分析新Ký ức是否揭示了关于旧Ký ức的新信息：
- 建立有意义的Liên kết连接
- 反向Cập nhật旧Ký ức的mô tả或分类

输出严格 JSON：
{
  "results": [
    {
      "node_id": "新Ký ức的nút ID",
      "action": "keep" | "merge" | "skip",
      "merge_target_id": "仅 action=merge 时必填：要合并到的旧nút ID",
      "merged_fields": { "仅 action=merge 时可选：合并后的字段Cập nhật" },
      "reason": "判定理由（简述）",
      "evolution": {
        "should_evolve": true/false,
        "connections": ["需要建立链接的旧Ký ức ID 列表"],
        "neighbor_updates": [
          {
            "nodeId": "需Cập nhật的旧nút ID",
            "newContext": "基于新信息修正后的mô tả（不需修改则为 null）",
            "newTags": ["Cập nhật后的分类标签，不需修改则为 null"]
          }
        ]
      }
    }
  ]
}

Hợp nhấtQuy tắc：
- 必须对每条新Ký ức都给出一个 result 条目
- 当 action=skip 时，evolution 可省略或设 should_evolve=false
- 当 action=merge 时，evolution 可省略或设 should_evolve=false
- 仅当 action=keep 且新信息确实改变了对旧Ký ức的理解时，才设 should_evolve=true
- 例如：揭露卧底身份 → 修正该Nhân vật之前Sự kiện中的动机mô tả
- 例如：发现Địa điểm的隐藏特性 → Cập nhậtĐịa điểmnút的mô tả
- 不要对Không关Ký ức强行建立联系
- neighbor_updates 中每条必须有实际意义的修改
- 必须保持剧情时间一致；不同时间段的Sự kiệnMặc định不要 merge
- 同名Sự kiện若剧情时间不同，除非明确是同一Sự kiện的补充，否则应 keep`;

function normalizeLatestOnlyIdentityValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function canMergeTemporalScopedMemories(leftNode, rightNode) {
  if (!canMergeScopedMemories(leftNode, rightNode)) {
    return false;
  }
  return isStoryTimeCompatible(leftNode, rightNode).compatible;
}

function buildConsolidationRankingQueryText(newEntries = []) {
  return (Array.isArray(newEntries) ? newEntries : [])
    .map((entry, index) => {
      const node = entry?.node;
      const fieldsText = Object.entries(node?.fields || {})
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      const storyTimeLabel = describeNodeStoryTime(node);
      return [
        `新Ký ức#${index + 1}`,
        `Loại=${String(node?.type || "").trim()}`,
        storyTimeLabel ? `剧情时间=${storyTimeLabel}` : "",
        fieldsText,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean)
    .join("\n");
}

export async function analyzeAutoConsolidationGate({
  graph,
  newNodeIds,
  embeddingConfig,
  schema = [],
  conflictThreshold = 0.85,
  signal,
} = {}) {
  const normalizedThreshold = Number.isFinite(Number(conflictThreshold))
    ? Math.max(0, Math.min(1, Number(conflictThreshold)))
    : 0.85;
  const safeNewNodeIds = Array.isArray(newNodeIds) ? newNodeIds : [];

  if (!graph || safeNewNodeIds.length === 0) {
    return {
      triggered: false,
      reason: "本批新增少且Không明显重复风险，Bỏ quaTự độngHợp nhất",
      matchedScore: null,
      matchedNodeId: "",
      detection: "none",
    };
  }

  const schemaByType = new Map(
    (Array.isArray(schema) ? schema : [])
      .filter((typeDef) => typeDef?.id)
      .map((typeDef) => [String(typeDef.id), typeDef]),
  );
  const activeNodes = getActiveNodes(graph).filter((node) => !node?.archived);
  const vectorConfigValid = validateVectorConfig(embeddingConfig).valid;
  let bestVectorMatch = null;

  for (const newNodeId of safeNewNodeIds) {
    throwIfAborted(signal);
    const node = getNode(graph, newNodeId);
    if (!node || node.archived) continue;

    const typeDef = schemaByType.get(String(node.type || ""));
    const scopedCandidates = activeNodes.filter(
      (candidate) =>
        candidate?.id !== node.id && canMergeTemporalScopedMemories(node, candidate),
    );

    if (typeDef?.latestOnly) {
      for (const field of ["name", "title"]) {
        const normalizedIdentity = normalizeLatestOnlyIdentityValue(
          node?.fields?.[field],
        );
        if (!normalizedIdentity) continue;
        const matchedNode = scopedCandidates.find(
          (candidate) =>
            candidate?.type === node.type &&
            normalizeLatestOnlyIdentityValue(candidate?.fields?.[field]) ===
              normalizedIdentity,
        );
        if (matchedNode) {
          return {
            triggered: true,
            reason: `本批仅新增 ${safeNewNodeIds.length}  nút，但 latestOnly 的 ${field} 与旧Ký ức完全一致，已触发Tự độngHợp nhất`,
            matchedScore: 1,
            matchedNodeId: matchedNode.id,
            detection: `latestOnly:${field}`,
          };
        }
      }
    }

    if (!vectorConfigValid) continue;
    const text = buildNodeVectorText(node);
    if (!text) continue;

    try {
      const neighbors = await findSimilarNodesByText(
        graph,
        text,
        embeddingConfig,
        1,
        scopedCandidates,
        signal,
      );
      const topNeighbor = Array.isArray(neighbors) ? neighbors[0] : null;
      if (!topNeighbor?.nodeId) continue;

      if (
        !bestVectorMatch ||
        Number(topNeighbor.score || 0) > Number(bestVectorMatch.score || 0)
      ) {
        bestVectorMatch = {
          score: Number(topNeighbor.score || 0),
          nodeId: topNeighbor.nodeId,
        };
      }

      if (Number(topNeighbor.score || 0) >= normalizedThreshold) {
        return {
          triggered: true,
          reason: `本批仅新增 ${safeNewNodeIds.length}  nút，但与旧Ký ức高度相似（${Number(topNeighbor.score || 0).toFixed(3)} >= ${normalizedThreshold.toFixed(2)}），已触发Tự độngHợp nhất`,
          matchedScore: Number(topNeighbor.score || 0),
          matchedNodeId: topNeighbor.nodeId,
          detection: "vector",
        };
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn(
        `[ST-BME] Tự độngHợp nhất门禁近邻Truy vấn thất bại (${newNodeId}):`,
        error?.message || error,
      );
    }
  }

  if (bestVectorMatch) {
    return {
      triggered: false,
      reason: `本批新增少且最高相似度 ${bestVectorMatch.score.toFixed(3)} 未达到阈值 ${normalizedThreshold.toFixed(2)}，Bỏ quaTự độngHợp nhất`,
      matchedScore: bestVectorMatch.score,
      matchedNodeId: bestVectorMatch.nodeId,
      detection: "vector",
    };
  }

  if (!vectorConfigValid) {
    return {
      triggered: false,
      reason: "本批新增少且当前VectorKhông khả dụng，未检测到明确重复风险，Bỏ quaTự độngHợp nhất",
      matchedScore: null,
      matchedNodeId: "",
      detection: "vector-unavailable",
    };
  }

  return {
    triggered: false,
    reason: "本批新增少且Không明显重复风险，Bỏ quaTự độngHợp nhất",
    matchedScore: null,
    matchedNodeId: "",
    detection: "none",
  };
}

/**
 * 统一Hợp nhất ký ức主函数（批量化版）
 *
 * 4 阶段架构：
 *   Phase 0: 收集有效新nút
 *   Phase 1: 批量 Embed（直连 1 lần embedBatch / Backend逐lần）
 *   Phase 2: 各nút查近邻（直连Cục bộ cosine / Backend逐lần query）
 *   Phase 3: 单lần LLM 批量判定
 *   Phase 4: 逐个Xử lýKết quả
 *
 * @param {object} params
 * @param {object} params.graph - 当前图Trạng thái
 * @param {string[]} params.newNodeIds - 本lần新创建的nút ID 列表
 * @param {object} params.embeddingConfig - Embedding Cấu hình API
 * @param {object} [params.options]
 * @param {number} [params.options.neighborCount=5]
 * @param {number} [params.options.conflictThreshold=0.85]
 * @param {string} [params.customPrompt]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{merged: number, skipped: number, kept: number, evolved: number, connections: number, updates: number}>}
 */
export async function consolidateMemories({
  graph,
  newNodeIds,
  embeddingConfig,
  schema = [],
  options = {},
  customPrompt,
  signal,
  settings = {},
}) {
  const neighborCount = options.neighborCount ?? 5;
  const conflictThreshold = options.conflictThreshold ?? 0.85;
  const stats = {
    merged: 0,
    skipped: 0,
    kept: 0,
    evolved: 0,
    connections: 0,
    updates: 0,
  };

  if (!newNodeIds || newNodeIds.length === 0) return stats;
  if (!validateVectorConfig(embeddingConfig).valid) {
    debugLog("[ST-BME] Hợp nhất ký ứcBỏ qua：VectorCấu hìnhKhông khả dụng");
    return stats;
  }

  // ══════════════════════════════════════════════
  // Phase 0: 收集有效新nút
  // ══════════════════════════════════════════════
  const newEntries = [];
  for (const id of newNodeIds) {
    const node = getNode(graph, id);
    if (!node || node.archived) continue;
    const text = buildNodeVectorText(node);
    if (!text) continue;
    newEntries.push({ id, node, text });
  }

  if (newEntries.length === 0) return stats;

  const activeNodes = getActiveNodes(graph).filter((n) => {
    const text = buildNodeVectorText(n);
    return typeof text === "string" && text.length > 0;
  });

  if (activeNodes.length < 2) {
    // 图中nút不够，Tất cả keep
    stats.kept = newEntries.length;
    return stats;
  }

  throwIfAborted(signal);
  debugLog(`[ST-BME] Hợp nhất ký ức开始: ${newEntries.length} 个新nút`);

  // ══════════════════════════════════════════════
  // Phase 1 + 2: 批量 Embed + 查近邻
  // ══════════════════════════════════════════════
  /** @type {Map<string, Array<{nodeId: string, score: number}>>} */
  const neighborsMap = new Map();

  if (isDirectVectorConfig(embeddingConfig)) {
    // ── 直连模式: 1 lần embedBatch + N lầnCục bộ cosine ──
    const texts = newEntries.map((e) => e.text);
    let queryVectors;

    try {
      queryVectors = await embedBatch(texts, embeddingConfig, { signal });
    } catch (e) {
      if (isAbortError(e)) throw e;
      console.warn("[ST-BME] 批量 embed Thất bại，Lùi về到逐条:", e.message);
      queryVectors = null;
    }

    // 构建候选池（含 embedding 的Nút hoạt động）
    const candidatePool = activeNodes
      .filter((n) => Array.isArray(n.embedding) && n.embedding.length > 0)
      .map((n) => ({ nodeId: n.id, embedding: n.embedding }));

    for (let i = 0; i < newEntries.length; i++) {
      throwIfAborted(signal);
      const entry = newEntries[i];
      const candidates = candidatePool.filter((c) => {
        if (c.nodeId === entry.id) return false;
        const candidateNode = getNode(graph, c.nodeId);
        return canMergeTemporalScopedMemories(entry.node, candidateNode);
      });

      if (queryVectors?.[i] && candidates.length > 0) {
        // Cục bộ cosine Tìm kiếm（0 API 调用）
        const neighbors = searchSimilar(
          queryVectors[i],
          candidates,
          neighborCount,
        );
        neighborsMap.set(entry.id, neighbors);
      } else {
        // fallback: 逐条 embed
        try {
          const neighbors = await findSimilarNodesByText(
            graph,
            entry.text,
            embeddingConfig,
            neighborCount,
            activeNodes.filter((n) => n.id !== entry.id),
            signal,
          );
          neighborsMap.set(entry.id, neighbors);
        } catch (e) {
          if (isAbortError(e)) throw e;
          console.warn(`[ST-BME] 近邻Truy vấn thất bại (${entry.id}):`, e.message);
          neighborsMap.set(entry.id, []);
        }
      }
    }
  } else {
    // ── Backend模式: 逐条 /api/vector/query ──
    for (let i = 0; i < newEntries.length; i++) {
      throwIfAborted(signal);
      const entry = newEntries[i];
      try {
        const neighbors = await findSimilarNodesByText(
          graph,
          entry.text,
          embeddingConfig,
          neighborCount,
          activeNodes.filter(
            (n) => n.id !== entry.id && canMergeTemporalScopedMemories(entry.node, n),
          ),
          signal,
        );
        neighborsMap.set(entry.id, neighbors);
      } catch (e) {
        if (isAbortError(e)) throw e;
        console.warn(`[ST-BME] 近邻Truy vấn thất bại (${entry.id}):`, e.message);
        neighborsMap.set(entry.id, []);
      }
    }
  }

  // ══════════════════════════════════════════════
  // Phase 3: 单lần LLM 批量判定
  // ══════════════════════════════════════════════
  throwIfAborted(signal);

  const userPromptSections = [];
  userPromptSections.push(
    `本轮共新增 ${newEntries.length} 条Ký ức，请逐条分析：\n`,
  );

  for (let i = 0; i < newEntries.length; i++) {
    const entry = newEntries[i];
    const neighbors = neighborsMap.get(entry.id) || [];

    const newNodeFieldsStr = Object.entries(entry.node.fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const newNodeScope = buildScopeBadgeText(entry.node.scope);
    const newNodeStoryTime = describeNodeStoryTime(entry.node);

    // 构建近邻mô tả
    let neighborText;
    if (neighbors.length === 0) {
      neighborText = "  (Không近邻命中)";
    } else {
      neighborText = neighbors
        .map((n) => {
          const node = getNode(graph, n.nodeId);
          if (!node) return null;
          const fieldsStr = Object.entries(node.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          return `  - [${node.id}] Loại=${node.type}, Phạm vi tác dụng=${describeMemoryScope(node.scope)}${describeNodeStoryTime(node) ? `, 剧情时间=${describeNodeStoryTime(node)}` : ""}, ${fieldsStr} (相似度=${n.score.toFixed(3)})`;
        })
        .filter(Boolean)
        .join("\n");
    }

    // 检查高相似度
    const hasHighSimilarity =
      neighbors.length > 0 && neighbors[0].score > conflictThreshold;
    const hint = hasHighSimilarity
      ? `  ⚠ 最高相似度 ${neighbors[0].score.toFixed(3)} 超过阈值 ${conflictThreshold}`
      : "";

    userPromptSections.push(
      [
        `### 新Ký ức #${i + 1}`,
        `[${entry.id}] Loại=${entry.node.type}, Phạm vi tác dụng=${newNodeScope}${newNodeStoryTime ? `, 剧情时间=${newNodeStoryTime}` : ""}, ${newNodeFieldsStr}`,
        "近邻Ký ức:",
        neighborText,
        hint,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const userPrompt = userPromptSections.join("\n\n");
  const newNodeIdSet = new Set(newEntries.map((entry) => String(entry?.id || "").trim()));
  const consolidationGraphStats = await buildTaskGraphStats({
    graph,
    schema,
    userMessage: buildConsolidationRankingQueryText(newEntries),
    recentMessages: [],
    embeddingConfig,
    signal,
    activeNodes: activeNodes.filter(
      (node) => !newNodeIdSet.has(String(node?.id || "").trim()),
    ),
    rankingOptions: {
      topK: 12,
      diffusionTopK: 48,
      enableContextQueryBlend: false,
      enableMultiIntent: true,
      maxTextLength: 1200,
    },
    relevantHeading: "与本轮Hợp nhất最相关的既有nút",
  });

  let decision;
  const consolidationPromptBuild = await buildTaskPrompt(settings, "consolidation", {
    taskName: "consolidation",
    candidateNodes: userPrompt,
    candidateText: userPrompt,
    graphStats: consolidationGraphStats.graphStats,
    ...getSTContextForPrompt(),
  });
  const consolidationRegexInput = { entries: [] };
  const consolidationSystemPrompt = applyTaskRegex(
    settings,
    "consolidation",
    "finalPrompt",
    consolidationPromptBuild.systemPrompt ||
      customPrompt ||
      CONSOLIDATION_SYSTEM_PROMPT,
    consolidationRegexInput,
    "system",
  );
  const promptPayload = resolveTaskPromptPayload(
    consolidationPromptBuild,
    userPrompt,
  );
  const llmSystemPrompt =
    Array.isArray(promptPayload.promptMessages) &&
    promptPayload.promptMessages.length > 0
      ? String(promptPayload.systemPrompt || "")
      : String(promptPayload.systemPrompt || consolidationSystemPrompt || "");
  try {
    decision = await callLLMForJSON({
      systemPrompt: llmSystemPrompt,
      userPrompt: promptPayload.userPrompt,
      maxRetries: 1,
      signal,
      taskType: "consolidation",
      debugContext: createTaskLlmDebugContext(
        consolidationPromptBuild,
        consolidationRegexInput,
      ),
      promptMessages: promptPayload.promptMessages,
      additionalMessages: promptPayload.additionalMessages,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    console.error("[ST-BME] Hợp nhất ký ức LLM Gọi thất bại:", e);
    stats.kept = newEntries.length;
    return stats;
  }

  // ══════════════════════════════════════════════
  // Phase 4: 逐个Xử lýKết quả
  // ══════════════════════════════════════════════

  // 解析 LLM 返回——兼容单条和批量格式
  let results;
  if (Array.isArray(decision?.results)) {
    results = decision.results;
  } else if (decision?.action) {
    // 单条返回格式（LLM 可能忽略 results 包装）
    results = [{ ...decision, node_id: newEntries[0]?.id }];
  } else {
    console.warn("[ST-BME] Hợp nhất ký ức: LLM 返回格式异常，Tất cả keep");
    stats.kept = newEntries.length;
    return stats;
  }

  // 建立 node_id → result 的映射
  const resultMap = new Map();
  for (const r of results) {
    if (r.node_id) resultMap.set(r.node_id, r);
  }

  // Xử lý每个新nút
  for (const entry of newEntries) {
    const result = resultMap.get(entry.id);
    if (!result) {
      // LLM 未返回此nút的Kết quả，fallback 为 keep
      stats.kept++;
      continue;
    }

    processOneResult(graph, entry, result, stats);
  }

  // 日志
  const actionSummary = [];
  if (stats.merged > 0) actionSummary.push(`Hợp nhất ${stats.merged}`);
  if (stats.skipped > 0) actionSummary.push(`Bỏ qua ${stats.skipped}`);
  if (stats.kept > 0) actionSummary.push(`保留 ${stats.kept}`);
  if (stats.evolved > 0) actionSummary.push(`进化 ${stats.evolved}`);
  if (stats.connections > 0) actionSummary.push(`新链接 ${stats.connections}`);
  if (stats.updates > 0) actionSummary.push(`回溯Cập nhật ${stats.updates}`);

  if (actionSummary.length > 0) {
    debugLog(`[ST-BME] Hợp nhất ký ứcHoàn tất: ${actionSummary.join(", ")}`);
  }

  return stats;
}

/**
 * Xử lý单 nút的Hợp nhấtKết quả
 */
function processOneResult(graph, entry, result, stats) {
  const { id: newId, node: newNode } = entry;

  // ── Xử lý action ──
  switch (result.action) {
    case "skip": {
      debugLog(`[ST-BME] Hợp nhất ký ức: skip (重复) — ${newId}`);
      newNode.archived = true;
      stats.skipped++;
      break;
    }

    case "merge": {
      const targetId = result.merge_target_id;
      const targetNode = targetId ? getNode(graph, targetId) : null;

      if (
        targetNode &&
        !targetNode.archived &&
        canMergeTemporalScopedMemories(newNode, targetNode)
      ) {
        debugLog(`[ST-BME] Hợp nhất ký ức: merge ${newId} → ${targetId}`);

        if (result.merged_fields && typeof result.merged_fields === "object") {
          for (const [key, value] of Object.entries(result.merged_fields)) {
            if (value != null && value !== "") {
              targetNode.fields[key] = value;
            }
          }
        } else {
          for (const [key, value] of Object.entries(newNode.fields)) {
            if (value != null && value !== "" && !targetNode.fields[key]) {
              targetNode.fields[key] = value;
            }
          }
        }

        if (
          Number.isFinite(newNode.seq) &&
          newNode.seq > (targetNode.seq || 0)
        ) {
          targetNode.seq = newNode.seq;
        }

        const targetRange = Array.isArray(targetNode.seqRange)
          ? targetNode.seqRange
          : [targetNode.seq || 0, targetNode.seq || 0];
        const newRange = Array.isArray(newNode.seqRange)
          ? newNode.seqRange
          : [newNode.seq || 0, newNode.seq || 0];
        targetNode.seqRange = [
          Math.min(targetRange[0], newRange[0]),
          Math.max(targetRange[1], newRange[1]),
        ];
        if (!String(targetNode?.storyTime?.segmentId || targetNode?.storyTime?.label || "").trim()) {
          targetNode.storyTime = { ...(newNode.storyTime || targetNode.storyTime || {}) };
        }
        if (!String(targetNode?.storyTimeSpan?.startSegmentId || targetNode?.storyTimeSpan?.startLabel || "").trim()) {
          targetNode.storyTimeSpan = {
            ...(newNode.storyTimeSpan || targetNode.storyTimeSpan || {}),
          };
        }

        targetNode.embedding = null;
        newNode.archived = true;
        stats.merged++;
      } else {
        console.warn(
          `[ST-BME] Hợp nhất ký ức: merge target ${targetId} 不存在，Lùi về为 keep`,
        );
        stats.kept++;
      }
      break;
    }

    case "keep":
    default: {
      stats.kept++;
      break;
    }
  }

  // ── Xử lý evolution ──
  const evolution = result.evolution;
  if (evolution?.should_evolve && !newNode.archived) {
    stats.evolved++;
    debugLog(`[ST-BME] Hợp nhất ký ức/进化触发: ${result.reason || "(Không理由)"}`);

    if (Array.isArray(evolution.connections)) {
      for (const targetId of evolution.connections) {
        if (!getNode(graph, targetId)) continue;
        const edge = createEdge({
          fromId: newId,
          toId: targetId,
          relation: "related",
          strength: 0.7,
        });
        if (addEdge(graph, edge)) {
          stats.connections++;
        }
      }
    }

    if (Array.isArray(evolution.neighbor_updates)) {
      for (const update of evolution.neighbor_updates) {
        if (!update.nodeId) continue;
        const oldNode = getNode(graph, update.nodeId);
        if (
          !oldNode ||
          oldNode.archived ||
          !canMergeTemporalScopedMemories(newNode, oldNode)
        ) {
          continue;
        }

        let changed = false;

        if (update.newContext && typeof update.newContext === "string") {
          if (oldNode.fields.state !== undefined) {
            oldNode.fields.state = update.newContext;
            changed = true;
          } else if (oldNode.fields.summary !== undefined) {
            oldNode.fields.summary = update.newContext;
            changed = true;
          } else if (oldNode.fields.core_note !== undefined) {
            oldNode.fields.core_note = update.newContext;
            changed = true;
          }
        }

        if (update.newTags && Array.isArray(update.newTags)) {
          oldNode.clusters = update.newTags;
          changed = true;
        }

        if (changed) {
          oldNode.embedding = null;
          if (!oldNode._evolutionHistory) oldNode._evolutionHistory = [];
          oldNode._evolutionHistory.push({
            triggeredBy: newId,
            timestamp: Date.now(),
            reason: result.reason || "",
          });
          stats.updates++;
        }
      }
    }
  }
}
