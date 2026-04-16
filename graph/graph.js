// ST-BME: mô hình dữ liệu đồ thị
// Quản lý thao tác CRUD của nút và cạnh, cùng với việc tuần tự hóa vào chat_metadata

import {
  createDefaultBatchJournal,
  createDefaultHistoryState,
  createDefaultMaintenanceJournal,
  createDefaultVectorIndexState,
  normalizeGraphRuntimeState,
  PROCESSED_MESSAGE_HASH_VERSION,
} from "../runtime/runtime-state.js";
import {
  hasSameScopeIdentity,
  normalizeEdgeMemoryScope,
  normalizeMemoryScope,
  normalizeNodeMemoryScope,
  isSameLatestScopeBucket,
} from "./memory-scope.js";
import {
  createDefaultKnowledgeState,
  createDefaultRegionState,
} from "./knowledge-state.js";
import {
  createDefaultStoryTime,
  createDefaultStoryTimeSpan,
  createDefaultTimelineState,
  normalizeGraphStoryTimeline,
  normalizeNodeStoryTimeline,
  normalizeStoryTime,
  normalizeStoryTimeSpan,
} from "./story-timeline.js";
import {
  createDefaultSummaryState,
  importLegacySynopsisToSummaryState,
  normalizeGraphSummaryState,
} from "./summary-state.js";
import { debugLog } from "../runtime/debug-logging.js";

/**
 * Số phiên bản trạng thái đồ thị
 */
const GRAPH_VERSION = 9;

/**
 * sinh UUID v4
 */
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Tạo trạng thái đồ thị rỗng
 * @returns {GraphState}
 */
export function createEmptyGraph() {
  return normalizeGraphRuntimeState({
    version: GRAPH_VERSION,
    lastProcessedSeq: -1,
    nodes: [],
    edges: [],
    lastRecallResult: null,
    historyState: createDefaultHistoryState(),
    vectorIndexState: createDefaultVectorIndexState(),
    batchJournal: createDefaultBatchJournal(),
    maintenanceJournal: createDefaultMaintenanceJournal(),
    knowledgeState: createDefaultKnowledgeState(),
    regionState: createDefaultRegionState(),
    timelineState: createDefaultTimelineState(),
    summaryState: createDefaultSummaryState(),
  });
}

// ==================== nútThao tác ====================

/**
 * Tạo nút mới
 * @param {object} params
 * @returns {object} nút mới
 */
export function createNode({
  type,
  fields = {},
  seq = 0,
  seqRange = null,
  importance = 5.0,
  clusters = [],
  scope = undefined,
}) {
  const now = Date.now();
  return {
    id: uuid(),
    type,
    level: 0,
    parentId: null,
    childIds: [],
    seq,
    seqRange: seqRange || [seq, seq],
    archived: false,
    fields,
    embedding: null,
    importance: Math.max(0, Math.min(10, importance)),
    accessCount: 0,
    updatedAt: now,
    lastAccessTime: now,
    createdTime: now,
    prevId: null,
    nextId: null,
    clusters,
    scope: normalizeMemoryScope(scope),
    storyTime: createDefaultStoryTime(),
    storyTimeSpan: createDefaultStoryTimeSpan(),
  };
}

/**
 * Thêm nút vào đồ thị
 * @param {GraphState} graph
 * @param {object} node
 * @returns {object} nút đã thêm
 */
export function addNode(graph, node) {
  // Danh sách liên kết thời gian của các nút cùng loại: nối tới nút cùng loại cuối cùng
  const sameTypeNodes = graph.nodes
    .filter(
      (n) =>
        n.type === node.type &&
        !n.archived &&
        n.level === 0 &&
        hasSameScopeIdentity(n.scope, node.scope),
    )
    .sort((a, b) => a.seq - b.seq);

  if (sameTypeNodes.length > 0) {
    const lastNode = sameTypeNodes[sameTypeNodes.length - 1];
    lastNode.nextId = node.id;
    node.prevId = lastNode.id;
  }

  graph.nodes.push(node);
  return node;
}

/**
 * dựa theo ID lấynút
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object|null}
 */
export function getNode(graph, nodeId) {
  return graph.nodes.find((n) => n.id === nodeId) || null;
}

/**
 * Cập nhật trường của nút (cập nhật từng phần)
 * @param {GraphState} graph
 * @param {string} nodeId
 * @param {object} updates - các trường cần cập nhật
 * @returns {boolean} có tìm thấy và cập nhật được hay không
 */
export function updateNode(graph, nodeId, updates) {
  const node = getNode(graph, nodeId);
  if (!node) return false;

  const nextUpdatedAt = Number.isFinite(Number(updates?.updatedAt))
    ? Number(updates.updatedAt)
    : Date.now();

  if (updates.fields) {
    node.fields = { ...node.fields, ...updates.fields };
    delete updates.fields;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "scope")) {
    node.scope = normalizeMemoryScope(updates.scope, node.scope || {});
    delete updates.scope;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "storyTime")) {
    node.storyTime = normalizeStoryTime(updates.storyTime, node.storyTime || {});
    delete updates.storyTime;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "storyTimeSpan")) {
    node.storyTimeSpan = normalizeStoryTimeSpan(
      updates.storyTimeSpan,
      node.storyTimeSpan || {},
    );
    delete updates.storyTimeSpan;
  }

  Object.assign(node, updates);
  node.updatedAt = nextUpdatedAt;
  return true;
}

/**
 * Xóa nút và các cạnh liên quan
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {boolean}
 */
export function removeNode(graph, nodeId, visited = new Set()) {
  const normalizedNodeId = String(nodeId || "");
  if (!normalizedNodeId) return false;
  if (visited.has(normalizedNodeId)) return false;
  visited.add(normalizedNodeId);

  const node = getNode(graph, normalizedNodeId);
  if (!node) return false;

  // Sửa danh sách liên kết thời gian
  if (node.prevId) {
    const prev = getNode(graph, node.prevId);
    if (prev) prev.nextId = node.nextId;
  }
  if (node.nextId) {
    const next = getNode(graph, node.nextId);
    if (next) next.prevId = node.prevId;
  }

  // Xóa đệ quy nút con (có bảo vệ vòng lặp)
  for (const childId of node.childIds) {
    removeNode(graph, childId, visited);
  }

  // Xóa tham chiếu khỏi nút cha
  if (node.parentId) {
    const parent = getNode(graph, node.parentId);
    if (parent) {
      parent.childIds = parent.childIds.filter((id) => id !== normalizedNodeId);
    }
  }

  // Đồng thời dọn sạch các tham chiếu child bẩn có thể còn sót trên nút khác để tránh vòng lặp còn lại khi nhập đồ thị bẩn
  for (const candidate of graph.nodes) {
    if (
      !Array.isArray(candidate?.childIds) ||
      candidate.id === normalizedNodeId
    ) {
      continue;
    }
    candidate.childIds = candidate.childIds.filter(
      (id) => id !== normalizedNodeId,
    );
  }

  // Xóa các cạnh liên quan
  graph.edges = graph.edges.filter(
    (e) => e.fromId !== normalizedNodeId && e.toId !== normalizedNodeId,
  );

  // Xóa chính nút đó
  graph.nodes = graph.nodes.filter((n) => n.id !== normalizedNodeId);

  return true;
}

/**
 * Lấy toàn bộ nút chưa lưu trữ
 * @param {GraphState} graph
 * @param {string} [typeFilter] - tùy chọnLoạiLọc
 * @returns {object[]}
 */
export function getActiveNodes(graph, typeFilter = null) {
  let nodes = graph.nodes.filter((n) => !n.archived);
  if (typeFilter) {
    nodes = nodes.filter((n) => n.type === typeFilter);
  }
  return nodes;
}

/**
 * Tìm nút phiên bản mới nhất theo loại (dùng cho loại latestOnly)
 * @param {GraphState} graph
 * @param {string} type
 * @param {string} primaryKeyValue - giá trị khóa chính (ví dụ tên nhân vật)
 * @param {string} primaryKeyField - tên trường khóa chính (mặc định 'name')
 * @returns {object|null}
 */
export function findLatestNode(
  graph,
  type,
  primaryKeyValue,
  primaryKeyField = "name",
  scope = undefined,
) {
  const candidates = graph.nodes.filter(
    (n) =>
      n.type === type &&
      !n.archived &&
      n.fields[primaryKeyField] === primaryKeyValue &&
      (scope == null ||
        isSameLatestScopeBucket(n, {
          type,
          primaryKeyValue,
          primaryKeyField,
          scope,
        })),
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.seq - a.seq)[0];
}

// ==================== Thao tác trên cạnh ====================

/**
 * Tạo cạnh
 * @param {object} params
 * @returns {object} cạnh mới
 */
export function createEdge({
  fromId,
  toId,
  relation = "related",
  strength = 0.8,
  edgeType = 0,
  scope = undefined,
}) {
  const now = Date.now();
  return {
    id: uuid(),
    fromId,
    toId,
    relation,
    strength: Math.max(0, Math.min(1, strength)),
    edgeType,
    createdTime: now,
    updatedAt: now,
    // Trường theo thời gian lấy cảm hứng từ Graphiti
    validAt: now, // thời điểm quan hệ có hiệu lực
    invalidAt: null, // quan hệmất hiệu lựcthời gian（null = hiện tạihợp lệ）
    expiredAt: null, // thời điểm hệ thống đánh dấu hết hiệu lực
    scope: normalizeMemoryScope(scope),
  };
}

/**
 * Thêm cạnh vào đồ thị (kiểm tra sự tồn tại của nút)
 * @param {GraphState} graph
 * @param {object} edge
 * @returns {object|null} cạnh đã thêm hoặc null
 */
export function addEdge(graph, edge) {
  const from = getNode(graph, edge.fromId);
  const to = getNode(graph, edge.toId);
  if (!from || !to) return null;
  if (edge.fromId === edge.toId) return null;

  const isCurrentEdgeValid = (candidate) => {
    if (candidate.invalidAt) return false;
    if (candidate.expiredAt) return false;
    return true;
  };

  // Khử trùng lặp cho các cạnh hiện còn hiệu lực; giữ lại cạnh lịch sử để tránh lịch sử làm nhiễu truy xuất hiện tại
  const existing = graph.edges.find(
    (e) =>
      e.fromId === edge.fromId &&
      e.toId === edge.toId &&
      e.relation === edge.relation &&
      JSON.stringify(normalizeMemoryScope(e.scope)) ===
        JSON.stringify(normalizeMemoryScope(edge.scope)) &&
      isCurrentEdgeValid(e),
  );
  if (existing) {
    existing.strength = Math.max(existing.strength, edge.strength ?? 0);
    existing.validAt = Math.max(
      existing.validAt || 0,
      edge.validAt || Date.now(),
    );
    existing.updatedAt = Math.max(
      Number(existing.updatedAt || 0),
      Number(edge.updatedAt || 0),
      Number(existing.validAt || 0),
    );
    if (edge.invalidAt) {
      existing.invalidAt = edge.invalidAt;
      existing.updatedAt = Math.max(
        Number(existing.updatedAt || 0),
        Number(existing.invalidAt || 0),
      );
    }
    if (edge.expiredAt) {
      existing.expiredAt = edge.expiredAt;
      existing.updatedAt = Math.max(
        Number(existing.updatedAt || 0),
        Number(existing.expiredAt || 0),
      );
    }
    return existing;
  }

  if (!Number.isFinite(Number(edge.updatedAt))) {
    edge.updatedAt = Math.max(
      Number(edge.validAt || 0),
      Number(edge.createdTime || Date.now()),
    );
  }

  graph.edges.push(edge);
  return edge;
}

/**
 * Gỡ cạnh
 * @param {GraphState} graph
 * @param {string} edgeId
 * @returns {boolean}
 */
export function removeEdge(graph, edgeId) {
  const idx = graph.edges.findIndex((e) => e.id === edgeId);
  if (idx === -1) return false;
  graph.edges.splice(idx, 1);
  return true;
}

/**
 * Lấy toàn bộ cạnh ra của nút
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getOutEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.fromId === nodeId);
}

/**
 * Lấy toàn bộ cạnh vào của nút
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getInEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.toId === nodeId);
}

/**
 * Lấy toàn bộ cạnh nối tới nút (vào + ra)
 * @param {GraphState} graph
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getNodeEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.fromId === nodeId || e.toId === nodeId);
}

// ==================== Hỗ trợ truy vấn ====================

/**
 * Xây dựng bảng kề cận (dùng cho engine khuếch tán)
 * @param {GraphState} graph
 * @returns {Map<string, Array<{targetId: string, strength: number, edgeType: number}>>}
 */
export function buildAdjacencyMap(graph) {
  const adj = new Map();
  const activeNodeIds = new Set(
    graph.nodes.filter((node) => !node.archived).map((node) => node.id),
  );

  for (const edge of graph.edges) {
    if (!isEdgeActive(edge)) continue;
    if (!activeNodeIds.has(edge.fromId) || !activeNodeIds.has(edge.toId)) {
      continue;
    }

    if (!adj.has(edge.fromId)) adj.set(edge.fromId, []);
    adj.get(edge.fromId).push({
      targetId: edge.toId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });

    if (!adj.has(edge.toId)) adj.set(edge.toId, []);
    adj.get(edge.toId).push({
      targetId: edge.fromId,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });
  }

  return adj;
}

/**
 * Xây dựng bảng kề cận có nhận biết thời gian (lọc cạnh mất hiệu lực)
 * Lấy cảm hứng từ Graphiti: chỉ đưa các cạnh "hiện còn hiệu lực" vào
 * @param {GraphState} graph
 * @returns {Map}
 */
export function buildTemporalAdjacencyMap(graph, options = {}) {
  const adj = new Map();
  adj.syntheticEdgeCount = 0;
  const activeNodeIds = new Set(
    graph.nodes.filter((node) => !node.archived).map((node) => node.id),
  );
  const includeTemporalLinks = options.includeTemporalLinks !== false;
  const temporalLinkStrength = Math.max(
    0,
    Math.min(1, Number(options.temporalLinkStrength) || 0.2),
  );

  for (const edge of graph.edges) {
    if (!isEdgeActive(edge)) continue;
    if (!activeNodeIds.has(edge.fromId) || !activeNodeIds.has(edge.toId)) {
      continue;
    }

    addAdjacencyPair(adj, edge.fromId, edge.toId, edge.strength, edge.edgeType);
  }

  if (includeTemporalLinks && temporalLinkStrength > 0) {
    const activeNodes = graph.nodes.filter(
      (node) => !node.archived && activeNodeIds.has(node.id),
    );
    const seenPairs = new Set();

    for (const node of activeNodes) {
      for (const neighborId of [node.prevId, node.nextId]) {
        if (!neighborId || !activeNodeIds.has(neighborId)) continue;
        const key = [node.id, neighborId].sort().join("::");
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        addAdjacencyPair(adj, node.id, neighborId, temporalLinkStrength, 0);
        adj.syntheticEdgeCount += 1;
      }
    }
  }

  return adj;
}

function addAdjacencyPair(adj, fromId, toId, strength, edgeType) {
  if (!adj.has(fromId)) adj.set(fromId, []);
  adj.get(fromId).push({
    targetId: toId,
    strength,
    edgeType,
  });

  if (!adj.has(toId)) adj.set(toId, []);
  adj.get(toId).push({
    targetId: fromId,
    strength,
    edgeType,
  });
}

function isEdgeActive(edge, now = Date.now()) {
  if (!edge) return false;
  if (edge.invalidAt && edge.invalidAt <= now) return false;
  if (edge.expiredAt && edge.expiredAt <= now) return false;
  return true;
}

/**
 * Đánh dấu cạnh là mất hiệu lực (không xóa, giữ lại lịch sử)
 * @param {object} edge
 */
export function invalidateEdge(edge) {
  if (!edge) return;
  const now = Date.now();
  if (!edge.invalidAt) {
    edge.invalidAt = now;
  }
  edge.updatedAt = Math.max(
    Number(edge.updatedAt || 0),
    Number(edge.invalidAt || now),
  );
}

/**
 * Lấy thông tin thống kê của đồ thị
 * @param {GraphState} graph
 * @returns {object}
 */
export function getGraphStats(graph) {
  const activeNodes = graph.nodes.filter((n) => !n.archived);
  const archivedNodes = graph.nodes.filter((n) => n.archived);
  const typeCounts = {};
  for (const node of activeNodes) {
    typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
  }

  return {
    totalNodes: graph.nodes.length,
    activeNodes: activeNodes.length,
    archivedNodes: archivedNodes.length,
    totalEdges: graph.edges.length,
    lastProcessedSeq: graph.lastProcessedSeq,
    typeCounts,
  };
}

// ==================== Tuần tự hóa ====================

/**
 * Tuần tự hóa trạng thái đồ thị thành chuỗi JSON
 * @param {GraphState} graph
 * @returns {string}
 */
export function serializeGraph(graph) {
  return JSON.stringify(graph);
}

/**
 * Giải tuần tự chuỗi JSON thành trạng thái đồ thị
 * @param {string} json
 * @returns {GraphState}
 */
export function deserializeGraph(json) {
  try {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    const shouldImportLegacySynopsis =
      !data?.summaryState ||
      typeof data.summaryState !== "object" ||
      Array.isArray(data.summaryState);

    if (!data || data.version === undefined) {
      return createEmptyGraph();
    }

    if (data.version < GRAPH_VERSION) {
      debugLog(`[ST-BME] Di chuyển phiên bản đồ thị v${data.version} → v${GRAPH_VERSION}`);

      if (data.version < 2 && data.edges) {
        for (const edge of data.edges) {
          if (edge.validAt === undefined)
            edge.validAt = edge.createdTime || Date.now();
          if (edge.invalidAt === undefined) edge.invalidAt = null;
          if (edge.expiredAt === undefined) edge.expiredAt = null;
        }
      }

      if (data.version < 3) {
        if (typeof data.lastProcessedSeq !== "number") {
          data.lastProcessedSeq = -1;
        }
        for (const node of data.nodes || []) {
          if (!Array.isArray(node.seqRange)) {
            const seq = Number.isFinite(node.seq) ? node.seq : 0;
            node.seqRange = [seq, seq];
          }
        }
      }

      if (data.version < 4) {
        data.historyState = {
          ...createDefaultHistoryState(),
          ...(data.historyState || {}),
          lastProcessedAssistantFloor: Number.isFinite(data.lastProcessedSeq)
            ? data.lastProcessedSeq
            : -1,
        };
        data.vectorIndexState = {
          ...createDefaultVectorIndexState(),
          ...(data.vectorIndexState || {}),
          dirty: true,
          lastWarning: "Phiên bản đồ thị cũ đã được di chuyển, cần xây lại trạng thái runtime của vector",
        };
        data.batchJournal = Array.isArray(data.batchJournal)
          ? data.batchJournal
          : createDefaultBatchJournal();
      }

      if (data.version < 5) {
        data.historyState = {
          ...createDefaultHistoryState(),
          ...(data.historyState || {}),
          extractionCount: Number.isFinite(data?.historyState?.extractionCount)
            ? data.historyState.extractionCount
            : 0,
          lastMutationSource: String(
            data?.historyState?.lastMutationSource || "",
          ),
        };
        data.batchJournal = Array.isArray(data.batchJournal)
          ? data.batchJournal
          : createDefaultBatchJournal();
      }

      if (data.version < 6) {
        for (const node of data.nodes || []) {
          node.scope = normalizeMemoryScope(node?.scope);
        }
        for (const edge of data.edges || []) {
          edge.scope = normalizeMemoryScope(edge?.scope);
        }
      }

      if (data.version < 7) {
        data.historyState = {
          ...createDefaultHistoryState(),
          ...(data.historyState || {}),
          activeRegionSource: String(
            data?.historyState?.activeRegionSource ||
              (data?.historyState?.activeRegion ? "history" : ""),
          ),
          activeRecallOwnerKey: String(
            data?.historyState?.activeRecallOwnerKey || "",
          ),
          recentRecallOwnerKeys: Array.isArray(
            data?.historyState?.recentRecallOwnerKeys,
          )
            ? data.historyState.recentRecallOwnerKeys
            : [],
        };
        data.maintenanceJournal = Array.isArray(data.maintenanceJournal)
          ? data.maintenanceJournal
          : createDefaultMaintenanceJournal();
        data.knowledgeState = createDefaultKnowledgeState(data.knowledgeState);
        data.regionState = createDefaultRegionState(data.regionState);
      }

      if (data.version < 8) {
        data.historyState = {
          ...createDefaultHistoryState(),
          ...(data.historyState || {}),
          activeStorySegmentId: String(
            data?.historyState?.activeStorySegmentId || "",
          ),
          activeStoryTimeLabel: String(
            data?.historyState?.activeStoryTimeLabel || "",
          ),
          activeStoryTimeSource: String(
            data?.historyState?.activeStoryTimeSource ||
              (data?.historyState?.activeStorySegmentId ||
              data?.historyState?.activeStoryTimeLabel
                ? "history"
                : ""),
          ),
          lastExtractedStorySegmentId: String(
            data?.historyState?.lastExtractedStorySegmentId || "",
          ),
        };
        data.timelineState = createDefaultTimelineState(data.timelineState);
        for (const node of data.nodes || []) {
          normalizeNodeStoryTimeline(node);
        }
      }

      if (data.version < 9) {
        data.summaryState = createDefaultSummaryState(data.summaryState);
      }

      data.version = GRAPH_VERSION;
    }

    data.nodes = (data.nodes || []).map((node) => {
      const seq = Number.isFinite(node.seq) ? node.seq : 0;
      return {
        level: 0,
        parentId: null,
        childIds: [],
        accessCount: 0,
        lastAccessTime: node.createdTime || Date.now(),
        prevId: null,
        nextId: null,
        clusters: [],
        ...node,
        seq,
        seqRange: Array.isArray(node.seqRange) ? node.seqRange : [seq, seq],
        scope: normalizeNodeMemoryScope(node),
        storyTime: createDefaultStoryTime(node?.storyTime || {}),
        storyTimeSpan: createDefaultStoryTimeSpan(node?.storyTimeSpan || {}),
      };
    });
    data.edges = (data.edges || []).map((edge) => {
      const normalizedEdge = {
        createdTime: Date.now(),
        validAt: edge?.createdTime || Date.now(),
        invalidAt: null,
        expiredAt: null,
        ...edge,
      };
      normalizedEdge.scope = normalizeEdgeMemoryScope(normalizedEdge);
      return normalizedEdge;
    });
    data.lastProcessedSeq = Number.isFinite(data.lastProcessedSeq)
      ? data.lastProcessedSeq
      : -1;
    data.lastRecallResult = Array.isArray(data.lastRecallResult)
      ? data.lastRecallResult
      : null;
    data.historyState = {
      ...createDefaultHistoryState(),
      ...(data.historyState || {}),
      lastProcessedAssistantFloor: Number.isFinite(
        data?.historyState?.lastProcessedAssistantFloor,
      )
        ? data.historyState.lastProcessedAssistantFloor
        : data.lastProcessedSeq,
      extractionCount: Number.isFinite(data?.historyState?.extractionCount)
        ? data.historyState.extractionCount
        : 0,
      lastMutationSource: String(data?.historyState?.lastMutationSource || ""),
    };
    data.vectorIndexState = {
      ...createDefaultVectorIndexState(data?.historyState?.chatId || ""),
      ...(data.vectorIndexState || {}),
    };
    data.batchJournal = Array.isArray(data.batchJournal)
      ? data.batchJournal
      : createDefaultBatchJournal();
    data.maintenanceJournal = Array.isArray(data.maintenanceJournal)
      ? data.maintenanceJournal
      : createDefaultMaintenanceJournal();
    data.knowledgeState = createDefaultKnowledgeState(data.knowledgeState);
    data.regionState = createDefaultRegionState(data.regionState);
    data.timelineState = createDefaultTimelineState(data.timelineState);
    data.summaryState = createDefaultSummaryState(data.summaryState);
    normalizeGraphStoryTimeline(data);

    const normalizedGraph = normalizeGraphRuntimeState(
      data,
      data?.historyState?.chatId || "",
    );
    normalizeGraphSummaryState(normalizedGraph);
    if (shouldImportLegacySynopsis) {
      importLegacySynopsisToSummaryState(normalizedGraph);
    }
    return normalizedGraph;
  } catch (e) {
    console.error("[ST-BME] Giải tuần tự đồ thị thất bại:", e);
    return createEmptyGraph();
  }
}

/**
 * Xuất dữ liệu đồ thị (không gồm embedding để giảm dung lượng)
 * @param {GraphState} graph
 * @returns {string} chuỗi JSON
 */
export function exportGraph(graph) {
  const exportData = {
    ...graph,
    historyState: {
      ...createDefaultHistoryState(graph?.historyState?.chatId || ""),
      ...(graph?.historyState || {}),
      lastProcessedAssistantFloor:
        graph?.historyState?.lastProcessedAssistantFloor ??
        graph?.lastProcessedSeq ??
        -1,
    },
    vectorIndexState: {
      ...createDefaultVectorIndexState(graph?.historyState?.chatId || ""),
      dirty: true,
      lastWarning: "Bản xuất đồ thị không bao gồm chỉ mục vector của runtime",
    },
    batchJournal: createDefaultBatchJournal(),
    maintenanceJournal: createDefaultMaintenanceJournal(),
    knowledgeState: createDefaultKnowledgeState(graph?.knowledgeState || {}),
    regionState: createDefaultRegionState(graph?.regionState || {}),
    timelineState: createDefaultTimelineState(graph?.timelineState || {}),
    summaryState: createDefaultSummaryState(graph?.summaryState || {}),
    nodes: graph.nodes.map((n) => ({ ...n, embedding: null })),
  };
  return JSON.stringify(exportData, null, 2);
}

/**
 * Nhập dữ liệu đồ thị
 * @param {string} json
 * @returns {GraphState}
 */
export function importGraph(json) {
  const graph = normalizeGraphRuntimeState(deserializeGraph(json));
  // Nút được nhập vào cần sinh lại embedding
  for (const node of graph.nodes) {
    node.embedding = null;
  }
  graph.batchJournal = createDefaultBatchJournal();
  graph.historyState.processedMessageHashVersion =
    PROCESSED_MESSAGE_HASH_VERSION;
  graph.historyState.processedMessageHashes = {};
  graph.historyState.processedMessageHashesNeedRefresh = true;
  graph.historyState.historyDirtyFrom = null;
  graph.vectorIndexState.hashToNodeId = {};
  graph.vectorIndexState.nodeToHash = {};
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.lastWarning = "Sau khi nhập đồ thị cần xây lại chỉ mục vector";
  return graph;
}

