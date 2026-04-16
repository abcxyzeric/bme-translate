// ST-BME: engine hợp nhất ký ức thống nhất (bản theo lô)
// Hợp nhất đối chiếu chính xác kiểu Mem0 + tiến hóa ký ức kiểu A-MEM thành một giai đoạn duy nhất
// embed theo lô + tra lân cận theo lô + một lần gọi LLM

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
 * thống nhấtHợp nhất ký ứcprompt hệ thống（hỗ trợhàng loạtđầu ra）
 */
const CONSOLIDATION_SYSTEM_PROMPT = `Bạn là bộ phân tích hợp nhất ký ức. Khi ký ức mới được thêm vào đồ thị tri thức, bạn cần đồng thời hoàn tất hai tác vụ:

**Tác vụ 1: phát hiện kiểm tra xung đột**
Phán định xem ký ức mới có xung đột hoặc trùng lặp với ký ức đã có ở vùng lân cận gần nhất hay không:
- skip: ký ức mới trùng khít hoàn toàn với ký ức đã có, nên loại bỏ
- merge: ký ức mới có chỉnh sửa hoặc bổ sung cho ký ức cũ, nên hợp nhất
- keep: ký ức mới có thông tin hoàn toàn mới, nên giữ lại

**Tác vụ 2: phân tích tiến hóa** (chỉ cần khi action=keep)
Phân tích xem ký ức mới có tiết lộ thông tin mới nào về ký ức cũ hay không:
- Thiết lập liên kết có ý nghĩa
- Cập nhật ngược mô tả hoặc phân loại của ký ức cũ

Đầu ra phải là JSON nghiêm ngặt:
{
  "results": [
    {
      "node_id": "ID nút của ký ức mới",
      "action": "keep" | "merge" | "skip",
      "merge_target_id": "Chỉ bắt buộc khi action=merge: ID nút cũ sẽ được hợp nhất vào",
      "merged_fields": { "Tùy chọn khi action=merge: cập nhật trường sau khi hợp nhất" },
      "reason": "Lý do phán định (mô tả ngắn)",
      "evolution": {
        "should_evolve": true/false,
        "connections": ["Danh sách ID ký ức cũ cần tạo liên kết"],
        "neighbor_updates": [
          {
            "nodeId": "ID nút cũ cần cập nhật",
            "newContext": "Mô tả đã sửa theo thông tin mới (nếu không cần sửa thì để null)",
            "newTags": ["Nhãn phân loại sau cập nhật, nếu không cần sửa thì để null"]
          }
        ]
      }
    }
  ]
}

Hợp nhấtQuy tắc：
- Bắt buộc phải cho ra một mục result cho mỗi ký ức mới
- Khi action=skip, evolution có thể bỏ qua hoặc đặt should_evolve=false
- Khi action=merge, evolution có thể bỏ qua hoặc đặt should_evolve=false
- Chỉ đặt should_evolve=true khi action=keep và thông tin mới thật sự làm thay đổi cách hiểu về ký ức cũ
- Ví dụ: lộ thân phận nằm vùng → sửa mô tả động cơ trong các sự kiện trước đó của nhân vật
- Ví dụ: phát hiện đặc tính ẩn của địa điểm → cập nhật mô tả của nút địa điểm
- Đừng cố tạo liên hệ với ký ức không liên quan
- Mỗi mục trong neighbor_updates bắt buộc phải có chỉnh sửa mang ý nghĩa thực tế
- Bắt buộc phải giữ thời gian cốt truyện nhất quán; các sự kiện ở đoạn thời gian khác nhau mặc định không nên merge
- Nếu sự kiện cùng tên nhưng khác thời gian cốt truyện thì, trừ khi rõ ràng là phần bổ sung của cùng một sự kiện, còn lại nên keep`;

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
        `Ký ức mới #${index + 1}`,
        `Loại=${String(node?.type || "").trim()}`,
        storyTimeLabel ? `thời gian cốt truyện=${storyTimeLabel}` : "",
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
      reason: "Lô này thêm mới ít và không thấy rõ rủi ro trùng lặp, bỏ qua tự động hợp nhất",
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
            reason: `Lô này chỉ thêm ${safeNewNodeIds.length} nút, nhưng ${field} của latestOnly hoàn toàn khớp với ký ức cũ, đã kích hoạt tự động hợp nhất`,
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
          reason: `Lô này chỉ thêm ${safeNewNodeIds.length} nút, nhưng có độ tương tự rất cao với ký ức cũ (${Number(topNeighbor.score || 0).toFixed(3)} >= ${normalizedThreshold.toFixed(2)}), đã kích hoạt tự động hợp nhất`,
          matchedScore: Number(topNeighbor.score || 0),
          matchedNodeId: topNeighbor.nodeId,
          detection: "vector",
        };
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn(
        `[ST-BME] Truy vấn lân cận cho cổng tự động hợp nhất thất bại (${newNodeId}):`,
        error?.message || error,
      );
    }
  }

  if (bestVectorMatch) {
    return {
      triggered: false,
      reason: `Lô này thêm mới ít và độ tương đồng cao nhất ${bestVectorMatch.score.toFixed(3)} chưa đạt ngưỡng ${normalizedThreshold.toFixed(2)}, bỏ qua tự động hợp nhất`,
      matchedScore: bestVectorMatch.score,
      matchedNodeId: bestVectorMatch.nodeId,
      detection: "vector",
    };
  }

  if (!vectorConfigValid) {
    return {
      triggered: false,
      reason: "Lô này thêm mới ít và vector hiện không khả dụng, chưa phát hiện rủi ro trùng lặp rõ ràng, bỏ qua tự động hợp nhất",
      matchedScore: null,
      matchedNodeId: "",
      detection: "vector-unavailable",
    };
  }

  return {
    triggered: false,
    reason: "Lô này thêm mới ít và không thấy rõ rủi ro trùng lặp, bỏ qua tự động hợp nhất",
    matchedScore: null,
    matchedNodeId: "",
    detection: "none",
  };
}

/**
 * Hàm chính của hợp nhất ký ức thống nhất (bản theo lô)
 *
 * 4 giai đoạnkiến trúc：
 *   Phase 0: thu thập nút mới hợp lệ
 *   Phase 1: embed theo lô (nhánh nội bộ gọi 1 lần embedBatch / backend gọi từng lần)
 *   Phase 2: tra lân cận cho từng nút (nhánh nội bộ dùng cosine cục bộ / backend query từng lần)
 *   Phase 3: LLM phán định theo lô trong một lần gọi
 *   Phase 4: xử lý kết quả từng mục một
 *
 * @param {object} params
 * @param {object} params.graph - trạng thái đồ thị hiện tại
 * @param {string[]} params.newNodeIds - danh sách ID nút mới tạo ở lượt này
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
  // Phase 0: thu thập nút mới hợp lệ
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
    // Số nút trong đồ thị không đủ, giữ lại toàn bộ
    stats.kept = newEntries.length;
    return stats;
  }

  throwIfAborted(signal);
  debugLog(`[ST-BME] Bắt đầu hợp nhất ký ức: ${newEntries.length} nút mới`);

  // ══════════════════════════════════════════════
  // Phase 1 + 2: embed theo lô + tra lân cận
  // ══════════════════════════════════════════════
  /** @type {Map<string, Array<{nodeId: string, score: number}>>} */
  const neighborsMap = new Map();

  if (isDirectVectorConfig(embeddingConfig)) {
    // ── kết nối trực tiếpchế độ: 1 lần embedBatch + N lầnCục bộ cosine ──
    const texts = newEntries.map((e) => e.text);
    let queryVectors;

    try {
      queryVectors = await embedBatch(texts, embeddingConfig, { signal });
    } catch (e) {
      if (isAbortError(e)) throw e;
      console.warn("[ST-BME] Embed theo lô thất bại, lùi về xử lý từng mục:", e.message);
      queryVectors = null;
    }

    // Xây dựng pool ứng viên (các nút hoạt động có embedding)
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
        // Cục bộ cosine Tìm kiếm（0 API gọi）
        const neighbors = searchSimilar(
          queryVectors[i],
          candidates,
          neighborCount,
        );
        neighborsMap.set(entry.id, neighbors);
      } else {
        // Fallback: embed từng mục
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
          console.warn(`[ST-BME] lân cậnTruy vấn thất bại (${entry.id}):`, e.message);
          neighborsMap.set(entry.id, []);
        }
      }
    }
  } else {
    // ── Chế độ backend: gọi /api/vector/query từng mục ──
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
        console.warn(`[ST-BME] lân cậnTruy vấn thất bại (${entry.id}):`, e.message);
        neighborsMap.set(entry.id, []);
      }
    }
  }

  // ══════════════════════════════════════════════
  // Phase 3: LLM phán định theo lô trong một lần gọi
  // ══════════════════════════════════════════════
  throwIfAborted(signal);

  const userPromptSections = [];
  userPromptSections.push(
    `Lượt này có tổng cộng ${newEntries.length} ký ức mới, hãy phân tích từng mục:\n`,
  );

  for (let i = 0; i < newEntries.length; i++) {
    const entry = newEntries[i];
    const neighbors = neighborsMap.get(entry.id) || [];

    const newNodeFieldsStr = Object.entries(entry.node.fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const newNodeScope = buildScopeBadgeText(entry.node.scope);
    const newNodeStoryTime = describeNodeStoryTime(entry.node);

    // xây dựnglân cậnmô tả
    let neighborText;
    if (neighbors.length === 0) {
      neighborText = "  (Khônglân cậnkhớp trúng)";
    } else {
      neighborText = neighbors
        .map((n) => {
          const node = getNode(graph, n.nodeId);
          if (!node) return null;
          const fieldsStr = Object.entries(node.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          return `  - [${node.id}] Loại=${node.type}, Phạm vi tác dụng=${describeMemoryScope(node.scope)}${describeNodeStoryTime(node) ? `, thời gian cốt truyện=${describeNodeStoryTime(node)}` : ""}, ${fieldsStr} (độ tương đồng=${n.score.toFixed(3)})`;
        })
        .filter(Boolean)
        .join("\n");
    }

    // Kiểm tra độ tương đồng cao
    const hasHighSimilarity =
      neighbors.length > 0 && neighbors[0].score > conflictThreshold;
    const hint = hasHighSimilarity
      ? `  ⚠ Độ tương đồng cao nhất ${neighbors[0].score.toFixed(3)} vượt ngưỡng ${conflictThreshold}`
      : "";

    userPromptSections.push(
      [
        `### Ký ức mới #${i + 1}`,
        `[${entry.id}] Loại=${entry.node.type}, Phạm vi tác dụng=${newNodeScope}${newNodeStoryTime ? `, thời gian cốt truyện=${newNodeStoryTime}` : ""}, ${newNodeFieldsStr}`,
        "lân cậnKý ức:",
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
    relevantHeading: "Các nút đã có liên quan nhất tới lượt hợp nhất này",
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
  // Phase 4: xử lý kết quả từng mục
  // ══════════════════════════════════════════════

  // Phân tích đầu ra của LLM — tương thích cả định dạng đơn mục lẫn theo lô
  let results;
  if (Array.isArray(decision?.results)) {
    results = decision.results;
  } else if (decision?.action) {
    // Định dạng trả về đơn mục (LLM có thể bỏ qua lớp bọc results)
    results = [{ ...decision, node_id: newEntries[0]?.id }];
  } else {
    console.warn("[ST-BME] Hợp nhất ký ức: LLM trả vềđịnh dạngbất thường，Tất cả keep");
    stats.kept = newEntries.length;
    return stats;
  }

  // Tạo ánh xạ node_id → result
  const resultMap = new Map();
  for (const r of results) {
    if (r.node_id) resultMap.set(r.node_id, r);
  }

  // Xử lý từng nút mới
  for (const entry of newEntries) {
    const result = resultMap.get(entry.id);
    if (!result) {
      // LLM không trả về kết quả cho nút này, fallback về keep
      stats.kept++;
      continue;
    }

    processOneResult(graph, entry, result, stats);
  }

  // Nhật ký
  const actionSummary = [];
  if (stats.merged > 0) actionSummary.push(`Hợp nhất ${stats.merged}`);
  if (stats.skipped > 0) actionSummary.push(`Bỏ qua ${stats.skipped}`);
  if (stats.kept > 0) actionSummary.push(`giữ lại ${stats.kept}`);
  if (stats.evolved > 0) actionSummary.push(`tiến hóa ${stats.evolved}`);
  if (stats.connections > 0) actionSummary.push(`Liên kết mới ${stats.connections}`);
  if (stats.updates > 0) actionSummary.push(`Cập nhật hồi quy ${stats.updates}`);

  if (actionSummary.length > 0) {
    debugLog(`[ST-BME] Hợp nhất ký ứcHoàn tất: ${actionSummary.join(", ")}`);
  }

  return stats;
}

/**
 * Xử lý kết quả hợp nhất của một nút
 */
function processOneResult(graph, entry, result, stats) {
  const { id: newId, node: newNode } = entry;

  // ── Xử lý action ──
  switch (result.action) {
    case "skip": {
      debugLog(`[ST-BME] Hợp nhất ký ức: skip (trùng lặp) — ${newId}`);
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
          `[ST-BME] Hợp nhất ký ức: merge target ${targetId} không tồn tại, lùi về keep`,
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
    debugLog(`[ST-BME] Hợp nhất ký ức/tiến hóakích hoạt: ${result.reason || "(Khônglý do)"}`);

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


