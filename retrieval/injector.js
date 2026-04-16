// ST-BME: mô-đun tiêm prompt
// Định dạng kết quả truy xuất thành bảng để tiêm vào ngữ cảnh LLM

import { getSchemaType } from "../graph/schema.js";
import { normalizeMemoryScope } from "../graph/memory-scope.js";
import {
  describeStoryTime,
  describeStoryTimeSpan,
} from "../graph/story-timeline.js";
import { compareSummaryEntriesForDisplay } from "../graph/summary-state.js";

/**
 * Chuyển kết quả truy xuất thành văn bản tiêm
 *
 * @param {object} retrievalResult - giá trị trả về của retriever.retrieve()
 * @param {object[]} schema - nútLoại Schema
 * @returns {string} Văn bản tiêm
 */
export function formatInjection(retrievalResult, schema) {
  const {
    summaryEntries,
    coreNodes,
    recallNodes,
    groupedRecallNodes,
    scopeBuckets,
  } =
    retrievalResult;
  const showStoryTime =
    retrievalResult?.meta?.scopeContext?.injectStoryTimeLabel !== false;
  const parts = [];
  const appended = new Set();

  appendSummarySections(parts, summaryEntries || []);

  if (scopeBuckets && typeof scopeBuckets === "object") {
    appendCharacterPovSections(
      parts,
      scopeBuckets,
      retrievalResult?.meta?.retrieval?.sceneOwnerCandidates || [],
      schema,
      appended,
      showStoryTime,
    );
    appendScopeSection(
      parts,
      "[Memory - User POV / Not Character Facts]",
      scopeBuckets.userPov,
      schema,
      appended,
      showStoryTime,
      "Đây là ký ức chủ quan ở phía người dùng/người chơi, không đồng nghĩa với việc nhân vật đã biết sự thật; chỉ nên dùng làm tham chiếu cho quan hệ, lời hứa, cảm xúc và bối cảnh tương tác dài hạn.",
    );
    appendScopeSection(
      parts,
      "[Memory - Objective / Current Region]",
      scopeBuckets.objectiveCurrentRegion,
      schema,
      appended,
      showStoryTime,
    );
    appendScopeSection(
      parts,
      "[Memory - Objective / Global]",
      scopeBuckets.objectiveGlobal,
      schema,
      appended,
      showStoryTime,
    );

    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  // ========== Core thường trúTiêm ==========
  if (coreNodes.length > 0) {
    parts.push("[Memory - Core]");

    const grouped = groupByType(coreNodes);

    for (const [typeId, nodes] of grouped) {
      const typeDef = getSchemaType(schema, typeId);
      if (!typeDef) continue;

      const table = formatTable(nodes, typeDef, appended, showStoryTime);
      if (table) parts.push(table);
    }
  }

  // ========== Recall Truy hồiTiêm ==========
  if (recallNodes.length > 0) {
    parts.push("");
    parts.push("[Memory - Recalled]");

    const buckets = groupedRecallNodes || {
      state: recallNodes.filter(
        (n) => n.type === "character" || n.type === "location",
      ),
      episodic: recallNodes.filter(
        (n) => n.type === "event" || n.type === "thread",
      ),
      reflective: recallNodes.filter(
        (n) => n.type === "reflection" || n.type === "synopsis",
      ),
      rule: recallNodes.filter((n) => n.type === "rule"),
      other: recallNodes.filter(
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

    appendBucket(parts, "Trạng thái hiện tạiKý ức", buckets.state, schema, appended, showStoryTime);
    appendBucket(parts, "Ký ức sự kiện theo tình cảnh", buckets.episodic, schema, appended, showStoryTime);
    appendBucket(parts, "Phản tư và mốc neo dài hạn", buckets.reflective, schema, appended, showStoryTime);
    appendBucket(parts, "Quy tắc và ràng buộc", buckets.rule, schema, appended, showStoryTime);
    appendBucket(parts, "Ký ức liên kết khác", buckets.other, schema, appended, showStoryTime);
  }

  return parts.join("\n");
}

export function formatSummaryInjection(summaryEntries = []) {
  const parts = [];
  appendSummarySections(parts, summaryEntries);
  return parts.join("\n").trim();
}

function appendSummarySections(parts, summaryEntries = []) {
  const entries = (Array.isArray(summaryEntries) ? summaryEntries : [])
    .filter((entry) => String(entry?.status || "active") === "active" && String(entry?.text || "").trim())
    .sort(compareSummaryEntriesForDisplay);
  if (entries.length === 0) return;

  if (parts.length > 0) {
    parts.push("");
  }
  parts.push("[Summary - Active Frontier]");
  for (const entry of entries) {
    const level = Math.max(0, Number(entry?.level || 0));
    const range = Array.isArray(entry?.messageRange) ? entry.messageRange : ["?", "?"];
    const span = describeStoryTimeSpan(entry?.storyTimeSpan);
    const header =
      String(entry?.kind || "") === "rollup"
        ? `[Summary L${level} / Rolled Up / Tầng ${range[0]} ~ ${range[1]}]`
        : `[Summary L${level} / Tầng ${range[0]} ~ ${range[1]}]`;
    parts.push(header);
    if (span) {
      parts.push(`story_time_span: ${span}`);
    }
    parts.push(String(entry?.text || "").trim());
    parts.push("");
  }
  while (parts[parts.length - 1] === "") {
    parts.pop();
  }
}

function appendCharacterPovSections(
  parts,
  scopeBuckets,
  sceneOwnerCandidates,
  schema,
  appended,
  showStoryTime,
) {
  const byOwner =
    scopeBuckets?.characterPovByOwner &&
    typeof scopeBuckets.characterPovByOwner === "object"
      ? scopeBuckets.characterPovByOwner
      : {};
  const ownerOrder = Array.isArray(scopeBuckets?.characterPovOwnerOrder)
    ? scopeBuckets.characterPovOwnerOrder
    : [];

  if (ownerOrder.length > 0) {
    for (const ownerKey of ownerOrder) {
      const nodes = Array.isArray(byOwner[ownerKey]) ? byOwner[ownerKey] : [];
      if (nodes.length === 0) continue;
      appendScopeSection(
        parts,
        `[Memory - Character POV: ${resolveSceneOwnerLabel(ownerKey, nodes, sceneOwnerCandidates)}]`,
        nodes,
        schema,
        appended,
        showStoryTime,
      );
    }
    return;
  }

  appendScopeSection(
    parts,
    "[Memory - Character POV]",
    scopeBuckets?.characterPov,
    schema,
    appended,
    showStoryTime,
  );
}

function resolveSceneOwnerLabel(ownerKey, nodes = [], sceneOwnerCandidates = []) {
  const normalizedOwnerKey = String(ownerKey || "").trim();
  const candidateMatch = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .find((candidate) => String(candidate?.ownerKey || "").trim() === normalizedOwnerKey);
  if (candidateMatch?.ownerName) {
    return String(candidateMatch.ownerName);
  }
  const nodeMatch = (Array.isArray(nodes) ? nodes : [])
    .map((node) => normalizeMemoryScope(node?.scope))
    .find((scope) => scope.ownerName || scope.ownerId);
  return String(nodeMatch?.ownerName || nodeMatch?.ownerId || normalizedOwnerKey || "Nhân vật chưa đặt tên");
}

function appendScopeSection(parts, title, nodes, schema, appended, showStoryTime, note = "") {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  if (parts.length > 0) {
    parts.push("");
  }
  parts.push(title);
  if (note) {
    parts.push(note);
  }

  const grouped = groupByType(nodes);
  for (const [typeId, groupedNodes] of grouped) {
    const typeDef = getSchemaType(schema, typeId);
    if (!typeDef) continue;
    const table = formatTable(groupedNodes, typeDef, appended, showStoryTime);
    if (table) parts.push(table);
  }
}

/**
 * Nhóm nút theo loại
 */
function groupByType(nodes) {
  const map = new Map();
  for (const node of nodes) {
    if (!map.has(node.type)) map.set(node.type, []);
    map.get(node.type).push(node);
  }
  return map;
}

function appendBucket(parts, title, nodes, schema, appended, showStoryTime) {
  if (!nodes || nodes.length === 0) return;
  parts.push(`## ${title}`);

  const grouped = groupByType(nodes);
  for (const [typeId, groupedNodes] of grouped) {
    const typeDef = getSchemaType(schema, typeId);
    if (!typeDef) continue;

    const table = formatTable(groupedNodes, typeDef, appended, showStoryTime);
    if (table) parts.push(table);
  }
}

/**
 * Định dạng các nút cùng loại thành bảng Markdown
 */
function formatTable(nodes, typeDef, appended = new Set(), showStoryTime = true) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";

  const uniqueNodes = nodes.filter((node) => {
    if (!node?.id || appended.has(node.id)) return false;
    appended.add(node.id);
    return true;
  });

  if (uniqueNodes.length === 0) return "";

  // Xác định các cột cần hiển thị (các cột có dữ liệu thực tế)
  const activeCols = typeDef.columns.filter((col) =>
    uniqueNodes.some(
      (n) => n.fields?.[col.name] != null && n.fields[col.name] !== "",
    ),
  );
  const derivedCols = buildDerivedColumns(uniqueNodes, typeDef, showStoryTime);
  const allCols = [...derivedCols, ...activeCols];

  if (allCols.length === 0) return "";

  // Tiêu đề bảng
  const header = `| ${allCols.map((c) => c.name).join(" | ")} |`;
  const separator = `| ${allCols.map(() => "---").join(" | ")} |`;

  // Dòng dữ liệu
  const rows = uniqueNodes.map((node) => {
    const cells = allCols.map((col) => {
      const val =
        typeof col.getValue === "function"
          ? col.getValue(node)
          : node.fields?.[col.name] ?? "";
      // Escape ký tự ống và giới hạn độ dài ô
      return String(val)
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 200);
    });
    return `| ${cells.join(" | ")} |`;
  });

  return `${typeDef.tableName}:\n${header}\n${separator}\n${rows.join("\n")}`;
}

function buildDerivedColumns(nodes, typeDef, showStoryTime = true) {
  const derived = [];

  if (typeDef?.id === "pov_memory") {
    derived.push({
      name: "owner",
      getValue(node) {
        const scope = normalizeMemoryScope(node?.scope);
        const ownerLabel = scope.ownerName || scope.ownerId || "Chưa đặt tên";
        if (scope.ownerType === "user") {
          return `Người dùng: ${ownerLabel}`;
        }
        if (scope.ownerType === "character") {
          return `Nhân vật: ${ownerLabel}`;
        }
        return `POV: ${ownerLabel}`;
      },
    });
  }

  if (showStoryTime) {
    const pointTypes = new Set(["event", "pov_memory"]);
    const spanTypes = new Set(["thread", "synopsis", "reflection"]);
    if (
      pointTypes.has(typeDef?.id) &&
      nodes.some((node) => describeStoryTime(node?.storyTime))
    ) {
      derived.push({
        name: "story_time",
        getValue(node) {
          return describeStoryTime(node?.storyTime) || "";
        },
      });
    } else if (
      spanTypes.has(typeDef?.id) &&
      nodes.some((node) => describeStoryTimeSpan(node?.storyTimeSpan))
    ) {
      derived.push({
        name: "story_time_span",
        getValue(node) {
          return describeStoryTimeSpan(node?.storyTimeSpan) || "";
        },
      });
    }
  }

  return derived;
}

/**
 * Lấy ước tính tổng token của prompt tiêm
 * Ước tính sơ bộ: 1 token ≈ 2 ký tự CJK hoặc 4 ký tự Latin
 *
 * @param {string} injectionText
 * @returns {number} số token ước tính
 */
export function estimateTokens(injectionText) {
  if (!injectionText) return 0;
  // Ước tính đơn giản: chữ CJK 2 ký tự/token, tiếng Anh 4 ký tự/token
  const cnChars = (injectionText.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = injectionText.length - cnChars;
  return Math.ceil(cnChars / 2 + otherChars / 4);
}
