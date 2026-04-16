import { debugLog } from "../runtime/debug-logging.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { getActiveTaskProfile } from "../prompting/prompt-profiles.js";
import {
  appendSummaryEntry,
  createDefaultSummaryState,
  getActiveSummaryEntries,
  markSummaryEntriesFolded,
  normalizeGraphSummaryState,
} from "../graph/summary-state.js";
import {
  buildDialogueFloorMap,
  buildSummarySourceMessages,
  getDialogueFloorForChatIndex,
} from "./chat-history.js";
import { getSTContextForPrompt } from "../host/st-context.js";
import {
  deriveStoryTimeSpanFromNodes,
  describeNodeStoryTime,
} from "../graph/story-timeline.js";
import { getNode, getActiveNodes } from "../graph/graph.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import { normalizeMemoryScope } from "../graph/memory-scope.js";

function createAbortError(message = "Thao tácĐã chấm dứt") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
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

function clampInt(value, fallback = 0, min = 0, max = 999999) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeRange(range, fallback = [-1, -1]) {
  if (!Array.isArray(range) || range.length < 2) {
    return [...fallback];
  }
  const start = Number.isFinite(Number(range[0])) ? Number(range[0]) : fallback[0];
  const end = Number.isFinite(Number(range[1])) ? Number(range[1]) : fallback[1];
  return [start, end];
}

function getSummaryTaskInputConfig(settings = {}, taskType = "synopsis") {
  const profile = getActiveTaskProfile(settings, taskType);
  const input =
    profile?.input && typeof profile.input === "object" && !Array.isArray(profile.input)
      ? profile.input
      : {};
  return {
    rawChatContextFloors: clampInt(input.rawChatContextFloors, 0, 0, 200),
    rawChatSourceMode:
      String(input.rawChatSourceMode || "ignore_bme_hide").trim() ===
      "ignore_bme_hide"
        ? "ignore_bme_hide"
        : "ignore_bme_hide",
  };
}

function buildTranscript(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const seq = Number.isFinite(Number(message?.seq)) ? Number(message.seq) : "?";
      const role = String(message?.role || "assistant").trim() || "assistant";
      return `#${seq} [${role}]: ${String(message?.content || "")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function uniqueIds(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function collectJournalTouchedNodeIds(journal = {}) {
  return uniqueIds([
    ...(Array.isArray(journal?.createdNodeIds) ? journal.createdNodeIds : []),
    ...((Array.isArray(journal?.previousNodeSnapshots)
      ? journal.previousNodeSnapshots
      : []
    ).map((node) => node?.id)),
  ]);
}

function intersectsRange(leftRange, rightRange) {
  const [leftStart, leftEnd] = normalizeRange(leftRange);
  const [rightStart, rightEnd] = normalizeRange(rightRange);
  if (leftStart < 0 || leftEnd < 0 || rightStart < 0 || rightEnd < 0) {
    return false;
  }
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function buildDialogueRangeFromMessageRange(chat = [], messageRange = [-1, -1]) {
  const [messageStart, messageEnd] = normalizeRange(messageRange);
  if (messageStart < 0 || messageEnd < 0) {
    return [-1, -1];
  }
  const startFloor = getDialogueFloorForChatIndex(chat, messageStart);
  const endFloor = getDialogueFloorForChatIndex(chat, messageEnd);
  return [
    Number.isFinite(Number(startFloor)) ? Number(startFloor) : -1,
    Number.isFinite(Number(endFloor)) ? Number(endFloor) : -1,
  ];
}

function getSummaryEntryDialogueRange(chat = [], entry = {}) {
  const directRange = normalizeRange(entry?.dialogueRange);
  if (directRange[0] >= 0 && directRange[1] >= 0) {
    return directRange;
  }
  return buildDialogueRangeFromMessageRange(chat, entry?.messageRange);
}

function removeSummaryEntriesByIds(graph, entryIds = []) {
  normalizeGraphSummaryState(graph);
  const targetIds = new Set(uniqueIds(entryIds));
  if (targetIds.size === 0) return 0;
  const queue = [...targetIds];
  while (queue.length > 0) {
    const currentId = queue.shift();
    for (const entry of graph.summaryState.entries || []) {
      if (targetIds.has(entry.id)) continue;
      const sourceSummaryIds = Array.isArray(entry?.sourceSummaryIds)
        ? entry.sourceSummaryIds
        : [];
      if (!sourceSummaryIds.includes(currentId)) continue;
      targetIds.add(entry.id);
      queue.push(entry.id);
    }
  }

  graph.summaryState.entries = (graph.summaryState.entries || []).filter(
    (entry) => !targetIds.has(entry.id),
  );
  graph.summaryState.activeEntryIds = (graph.summaryState.activeEntryIds || []).filter(
    (entryId) => !targetIds.has(entryId),
  );
  return targetIds.size;
}

function findJournalForExtractionCount(graph, extractionCountBefore) {
  const target = Number(extractionCountBefore);
  const journals = Array.isArray(graph?.batchJournal) ? graph.batchJournal : [];
  for (let index = journals.length - 1; index >= 0; index -= 1) {
    const journal = journals[index];
    if (
      Number(journal?.stateBefore?.extractionCount) === target &&
      Array.isArray(journal?.processedRange)
    ) {
      return journal;
    }
  }
  return null;
}

function buildPseudoCurrentSlice(
  currentExtractionCount,
  currentRange,
  currentNodeIds = [],
  currentDialogueRange = null,
) {
  return {
    id: `summary-pending-${currentExtractionCount}`,
    extractionCountBefore: Math.max(0, currentExtractionCount - 1),
    extractionCountAfter: currentExtractionCount,
    processedRange: normalizeRange(currentRange),
    processedDialogueRange: normalizeRange(currentDialogueRange),
    touchedNodeIds: uniqueIds(currentNodeIds),
  };
}

function buildSliceFromJournal(journal = {}) {
  return {
    id: String(journal?.id || ""),
    extractionCountBefore: clampInt(journal?.stateBefore?.extractionCount, 0, 0, 999999),
    extractionCountAfter:
      clampInt(journal?.stateBefore?.extractionCount, 0, 0, 999999) + 1,
    processedRange: normalizeRange(journal?.processedRange),
    processedDialogueRange: normalizeRange(journal?.processedDialogueRange),
    touchedNodeIds: uniqueIds([
      ...(Array.isArray(journal?.touchedNodeIds) ? journal.touchedNodeIds : []),
      ...collectJournalTouchedNodeIds(journal),
    ]),
  };
}

function collectSlicesForSummaryWindow(
  graph,
  {
    lastSummarizedExtractionCount = 0,
    currentExtractionCount = 0,
    currentRange = null,
    currentDialogueRange = null,
    currentNodeIds = [],
    includeCurrentPending = false,
  } = {},
) {
  const slices = [];
  const safeLastCount = clampInt(lastSummarizedExtractionCount, 0, 0, 999999);
  const safeCurrentCount = clampInt(currentExtractionCount, 0, 0, 999999);
  const hasCurrentPendingRange =
    includeCurrentPending &&
    Array.isArray(currentRange) &&
    Number.isFinite(Number(currentRange[0])) &&
    Number.isFinite(Number(currentRange[1])) &&
    Number(currentRange[1]) >= Number(currentRange[0]);
  for (
    let beforeCount = safeLastCount;
    beforeCount < safeCurrentCount - (hasCurrentPendingRange ? 1 : 0);
    beforeCount += 1
  ) {
    const journal = findJournalForExtractionCount(graph, beforeCount);
    if (!journal) continue;
    slices.push(buildSliceFromJournal(journal));
  }
  if (hasCurrentPendingRange && safeCurrentCount > safeLastCount) {
    slices.push(
      buildPseudoCurrentSlice(
        safeCurrentCount,
        currentRange,
        currentNodeIds,
        currentDialogueRange,
      ),
    );
  }
  return slices.sort(
    (left, right) => left.extractionCountAfter - right.extractionCountAfter,
  );
}

function collectNodeHints(graph, nodeIds = []) {
  const nodes = uniqueIds(nodeIds)
    .map((nodeId) => getNode(graph, nodeId))
    .filter(Boolean);
  const regionHints = new Set();
  const ownerHints = new Set();
  for (const node of nodes) {
    const scope = normalizeMemoryScope(node?.scope);
    if (scope.regionPrimary) regionHints.add(scope.regionPrimary);
    if (scope.ownerName) ownerHints.add(scope.ownerName);
  }
  return {
    nodes,
    regionHints: [...regionHints],
    ownerHints: [...ownerHints],
  };
}

function describeNodeForSummary(node) {
  if (!node) return "";
  const storyLabel = describeNodeStoryTime(node);
  const prefix = storyLabel ? `[${storyLabel}] ` : "";
  switch (String(node.type || "")) {
    case "event":
      return `${prefix}${node.fields?.title || getNodeDisplayName(node)}: ${node.fields?.summary || "(Khôngtóm tắt)"}`;
    case "character":
      return `${prefix}${node.fields?.name || getNodeDisplayName(node)}: ${node.fields?.state || node.fields?.summary || "(KhôngTrạng thái)"}`;
    case "thread":
      return `${prefix}${node.fields?.title || getNodeDisplayName(node)}: ${node.fields?.status || node.fields?.summary || "(KhôngTrạng thái)"}`;
    case "pov_memory":
      return `${prefix}${getNodeDisplayName(node)}: ${node.fields?.summary || "(Khôngtóm tắt)"}`;
    default:
      return `${prefix}${getNodeDisplayName(node)}: ${node.fields?.summary || node.fields?.title || node.fields?.name || "(Khôngtóm tắt)"}`;
  }
}

function buildNodeDigest(graph, nodeIds = []) {
  return collectNodeHints(graph, nodeIds).nodes
    .map((node) => describeNodeForSummary(node))
    .filter(Boolean)
    .slice(0, 24)
    .join("\n");
}

function buildFrontierHint(graph) {
  const activeEntries = getActiveSummaryEntries(graph);
  if (activeEntries.length === 0) {
    return "Hiện chưa có tiền tuyến tóm tắt hoạt động.";
  }
  return activeEntries
    .slice(-6)
    .map((entry) => {
      const range = normalizeRange(entry.messageRange);
      return `L${entry.level} · Tầng ${range[0]} ~ ${range[1]} · ${String(entry.text || "").slice(0, 90)}`;
    })
    .join("\n");
}

function buildSummaryGraphStats(graph, activeEntries = []) {
  const historyState = graph?.historyState || {};
  const activeRegion = String(historyState.activeRegion || historyState.lastExtractedRegion || "").trim();
  const activeStoryTime = String(
    historyState.activeStoryTimeLabel || historyState.activeStorySegmentId || "",
  ).trim();
  return [
    `active_summary_count=${activeEntries.length}`,
    activeRegion ? `active_region=${activeRegion}` : "",
    activeStoryTime ? `active_story_time=${activeStoryTime}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function callSummaryTask({
  settings = {},
  taskType = "synopsis",
  context = {},
  fallbackSystemPrompt = "",
  fallbackUserPrompt = "",
  signal,
}) {
  const promptBuild = await buildTaskPrompt(settings, taskType, {
    taskName: taskType,
    ...context,
    ...getSTContextForPrompt(),
  });
  const regexInput = { entries: [] };
  const systemPrompt = applyTaskRegex(
    settings,
    taskType,
    "finalPrompt",
    promptBuild.systemPrompt || fallbackSystemPrompt,
    regexInput,
    "system",
  );
  const promptPayload = resolveTaskPromptPayload(promptBuild, fallbackUserPrompt);
  return await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(promptPayload, systemPrompt),
    userPrompt: promptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType,
    debugContext: createTaskLlmDebugContext(promptBuild, regexInput),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
  });
}

export async function generateSmallSummary({
  graph,
  chat = [],
  settings = {},
  currentExtractionCount = 0,
  currentAssistantFloor = -1,
  currentRange = [-1, -1],
  currentNodeIds = [],
  signal,
  force = false,
} = {}) {
  normalizeGraphSummaryState(graph);
  const summaryState = createDefaultSummaryState(graph?.summaryState || {});
  graph.summaryState = summaryState;

  const threshold = clampInt(
    settings.smallSummaryEveryNExtractions,
    3,
    1,
    100,
  );
  const deltaCount = Math.max(
    0,
    clampInt(currentExtractionCount, 0, 0, 999999) -
      clampInt(summaryState.lastSummarizedExtractionCount, 0, 0, 999999),
  );
  if (!force && deltaCount < threshold) {
    return {
      created: false,
      skipped: true,
      reason: `Hiện tại mới chỉ tích lũy ${deltaCount} lần trích xuất chưa được tổng kết, chưa tới ngưỡng tạo tóm tắt ngắn ${threshold}`,
    };
  }

  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: summaryState.lastSummarizedExtractionCount,
    currentExtractionCount,
    currentRange,
    currentDialogueRange: buildDialogueRangeFromMessageRange(chat, currentRange),
    currentNodeIds,
    includeCurrentPending: true,
  });
  if (slices.length === 0) {
    return {
      created: false,
      skipped: true,
      reason: "Hiện không có lô trích xuất nào dùng được để tạo tóm tắt ngắn",
    };
  }

  const firstSlice = slices[0];
  const lastSlice = slices[slices.length - 1];
  const inputConfig = getSummaryTaskInputConfig(settings, "synopsis");
  const messageStart = normalizeRange(firstSlice.processedRange)[0];
  const messageEnd = Math.max(
    normalizeRange(lastSlice.processedRange)[1],
    clampInt(currentAssistantFloor, -1, -1, 999999),
  );
  const sourceMessages = buildSummarySourceMessages(chat, messageStart, messageEnd, {
    rawChatContextFloors: inputConfig.rawChatContextFloors,
  });
  if (sourceMessages.length === 0) {
    return {
      created: false,
      skipped: true,
      reason: "Cửa sổ nguyên văn cho tóm tắt ngắn đang trống, đã bỏ qua",
    };
  }

  const messageRange = [
    Number.isFinite(Number(sourceMessages[0]?.seq)) ? Number(sourceMessages[0].seq) : messageStart,
    Number.isFinite(Number(sourceMessages[sourceMessages.length - 1]?.seq))
      ? Number(sourceMessages[sourceMessages.length - 1].seq)
      : messageEnd,
  ];
  const dialogueRange = buildDialogueRangeFromMessageRange(chat, messageRange);
  const sourceNodeIds = uniqueIds(
    slices.flatMap((slice) => Array.isArray(slice.touchedNodeIds) ? slice.touchedNodeIds : []),
  );
  const nodeDigest = buildNodeDigest(graph, sourceNodeIds) || "(KhôngNút then chốt hỗ trợ)";
  const activeFrontier = getActiveSummaryEntries(graph);
  const result = await callSummaryTask({
    settings,
    taskType: "synopsis",
    context: {
      recentMessages: buildTranscript(sourceMessages),
      chatMessages: sourceMessages,
      candidateText: nodeDigest,
      graphStats: [
        buildSummaryGraphStats(graph, activeFrontier),
        `frontier_hint:\n${buildFrontierHint(graph)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      currentRange: `Tầng ${messageRange[0]} ~ ${messageRange[1]}`,
    },
    fallbackSystemPrompt: [
      "Bạn là bộ sinh tóm tắt ngắn.",
      "Hãy dựa chủ yếu vào cửa sổ chat nguyên văn gần nhất, kết hợp bổ trợ từ các nút then chốt, để tạo một bản tóm tắt ngắn bám sát cục diện hiện tại.",
      'đầu ra JSON: {"summary":"văn bản tóm tắt (80-220 ký tự)"}',
      "Đừng viết dự đoán tương lai, đừng bịa thêm ngoài nguyên văn, và đừng trộn cứng nhiều tuyến thời gian vào với nhau.",
    ].join("\n"),
    fallbackUserPrompt: [
      "## Cửa sổ chat nguyên văn",
      buildTranscript(sourceMessages),
      "",
      "## Nút then chốt hỗ trợ",
      nodeDigest,
      "",
      "## hiện tạiTiền tuyến tóm tắt hoạt động",
      buildFrontierHint(graph),
    ].join("\n"),
    signal,
  });

  const summaryText = String(result?.summary || "").trim();
  if (!summaryText) {
    return {
      created: false,
      skipped: true,
      reason: "Tác vụ tóm tắt ngắn không trả về summary hợp lệ",
    };
  }

  const nodeHints = collectNodeHints(graph, sourceNodeIds);
  const storyTimeSpan = deriveStoryTimeSpanFromNodes(
    graph,
    nodeHints.nodes,
    "derived",
  );
  const entry = appendSummaryEntry(graph, {
    level: 0,
    kind: "small",
    status: "active",
    text: summaryText,
    sourceTask: "synopsis",
    extractionRange: [firstSlice.extractionCountAfter, lastSlice.extractionCountAfter],
    messageRange,
    dialogueRange,
    sourceBatchIds: uniqueIds(slices.map((slice) => slice.id)),
    sourceSummaryIds: [],
    sourceNodeIds,
    storyTimeSpan,
    regionHints: nodeHints.regionHints,
    ownerHints: nodeHints.ownerHints,
  });
  summaryState.lastSummarizedExtractionCount = lastSlice.extractionCountAfter;
  summaryState.lastSummarizedAssistantFloor = messageRange[1];
  debugLog("[ST-BME] Đã tạo tóm tắt ngắn", {
    entryId: entry.id,
    extractionRange: entry.extractionRange,
    messageRange: entry.messageRange,
  });
  return {
    created: true,
    entry,
    sourceMessages,
    sourceNodeIds,
    messageRange,
    dialogueRange,
  };
}

function buildRollupCandidateText(entries = []) {
  return entries
    .map((entry, index) => {
      const range = normalizeRange(entry.messageRange);
      return [
        `#${index + 1}`,
        `level=L${entry.level}`,
        `message_range=${range[0]}~${range[1]}`,
        `text=${String(entry.text || "")}`,
      ].join(" | ");
    })
    .join("\n");
}

function getFoldableSummaryGroup(graph, fanIn = 3, options = {}) {
  const requireExcess = options?.requireExcess === true;
  const activeEntries = getActiveSummaryEntries(graph);
  const byLevel = new Map();
  for (const entry of activeEntries) {
    if (!byLevel.has(entry.level)) {
      byLevel.set(entry.level, []);
    }
    byLevel.get(entry.level).push(entry);
  }
  const sortedLevels = [...byLevel.keys()].sort((left, right) => left - right);
  for (const level of sortedLevels) {
    const entries = byLevel.get(level) || [];
    if (requireExcess ? entries.length > fanIn : entries.length >= fanIn) {
      return entries.slice(0, fanIn);
    }
  }
  return [];
}

export async function rollupSummaryFrontier({
  graph,
  settings = {},
  signal,
  force = false,
} = {}) {
  normalizeGraphSummaryState(graph);
  const fanIn = clampInt(settings.summaryRollupFanIn, 3, 2, 10);
  const requireExcess = force !== true;
  const createdEntries = [];
  let foldedCount = 0;

  while (true) {
    throwIfAborted(signal);
    const candidates = getFoldableSummaryGroup(graph, fanIn, {
      requireExcess,
    });
    if (candidates.length < fanIn) {
      break;
    }

    const sourceNodeIds = uniqueIds(
      candidates.flatMap((entry) =>
        Array.isArray(entry.sourceNodeIds) ? entry.sourceNodeIds : [],
      ),
    );
    const nodeHints = collectNodeHints(graph, sourceNodeIds);
    const result = await callSummaryTask({
      settings,
      taskType: "summary_rollup",
      context: {
        candidateText: buildRollupCandidateText(candidates),
        graphStats: buildSummaryGraphStats(graph, getActiveSummaryEntries(graph)),
        currentRange: `Tầng ${normalizeRange(candidates[0]?.messageRange)[0]} ~ ${
          normalizeRange(candidates[candidates.length - 1]?.messageRange)[1]
        }`,
      },
      fallbackSystemPrompt: [
        "Bạn là bộ gộp tóm tắt.",
        "Hãy gộp nhiều bản tóm tắt đang hoạt động ở cùng tầng thành một bản tổng kết ổn định hơn và ở tầng cao hơn.",
        'đầu ra JSON: {"summary":"văn bản tổng kết sau khi gộp (120-260 ký tự)"}',
        "Đừng lặp lại nguyên câu, đừng làm mất cục diện vẫn còn hiệu lực ở hiện tại, và đừng phá vỡ thứ tự trước sau.",
      ].join("\n"),
      fallbackUserPrompt: [
        "## Tóm tắt chờ gộp",
        buildRollupCandidateText(candidates),
        "",
        "## Nút then chốt hỗ trợ",
        buildNodeDigest(graph, sourceNodeIds) || "(KhôngNút then chốt hỗ trợ)",
      ].join("\n"),
      signal,
    });
    const summaryText = String(result?.summary || "").trim();
    if (!summaryText) {
      return {
        createdCount: createdEntries.length,
        foldedCount,
        skipped: createdEntries.length === 0,
        reason: "Tác vụ gộp tóm tắt không trả về summary hợp lệ",
        createdEntries,
      };
    }

    const extractionRange = [
      Math.min(...candidates.map((entry) => normalizeRange(entry.extractionRange)[0])),
      Math.max(...candidates.map((entry) => normalizeRange(entry.extractionRange)[1])),
    ];
    const messageRange = [
      Math.min(...candidates.map((entry) => normalizeRange(entry.messageRange)[0])),
      Math.max(...candidates.map((entry) => normalizeRange(entry.messageRange)[1])),
    ];
    const dialogueRange = [
      Math.min(
        ...candidates.map((entry) => {
          const range = normalizeRange(entry?.dialogueRange, normalizeRange(entry?.messageRange));
          return range[0];
        }),
      ),
      Math.max(
        ...candidates.map((entry) => {
          const range = normalizeRange(entry?.dialogueRange, normalizeRange(entry?.messageRange));
          return range[1];
        }),
      ),
    ];
    const storyTimeSpan = deriveStoryTimeSpanFromNodes(
      graph,
      nodeHints.nodes,
      "derived",
    );
    markSummaryEntriesFolded(
      graph,
      candidates.map((entry) => entry.id),
    );
    foldedCount += candidates.length;
    const createdEntry = appendSummaryEntry(graph, {
      level: Number(candidates[0]?.level || 0) + 1,
      kind: "rollup",
      status: "active",
      text: summaryText,
      sourceTask: "summary_rollup",
      extractionRange,
      messageRange,
      dialogueRange,
      sourceBatchIds: uniqueIds(
        candidates.flatMap((entry) =>
          Array.isArray(entry.sourceBatchIds) ? entry.sourceBatchIds : [],
        ),
      ),
      sourceSummaryIds: candidates.map((entry) => entry.id),
      sourceNodeIds,
      storyTimeSpan,
      regionHints: nodeHints.regionHints,
      ownerHints: nodeHints.ownerHints,
    });
    createdEntries.push(createdEntry);
    debugLog("[ST-BME] Đã hoàn tất gộp tóm tắt", {
      createdEntryId: createdEntry.id,
      sourceSummaryIds: createdEntry.sourceSummaryIds,
    });
    if (!force) {
      continue;
    }
  }

  return {
    createdCount: createdEntries.length,
    foldedCount,
    createdEntries,
    skipped: createdEntries.length === 0,
    reason:
      createdEntries.length === 0
        ? requireExcess
          ? `Hiện không có ứng viên gộp nào có số lượng tóm tắt hoạt động cùng tầng vượt quá ${fanIn} mục`
          : `Hiện không có ứng viên gộp nào đạt ${fanIn} mục tóm tắt hoạt động cùng tầng`
        : "",
  };
}

export async function runHierarchicalSummaryPostProcess({
  graph,
  chat = [],
  settings = {},
  signal,
  currentExtractionCount = 0,
  currentAssistantFloor = -1,
  currentRange = [-1, -1],
  currentNodeIds = [],
} = {}) {
  normalizeGraphSummaryState(graph);
  if (settings.enableHierarchicalSummary === false) {
    return {
      smallSummary: null,
      rollup: null,
      created: false,
      reason: "Tóm tắt phân tầngcông tắcĐã tắt",
    };
  }

  const smallSummary = await generateSmallSummary({
    graph,
    chat,
    settings,
    currentExtractionCount,
    currentAssistantFloor,
    currentRange,
    currentNodeIds,
    signal,
    force: false,
  });
  if (!smallSummary?.created) {
    return {
      smallSummary,
      rollup: null,
      created: false,
      reason: smallSummary?.reason || "",
    };
  }

  const rollup = await rollupSummaryFrontier({
    graph,
    settings,
    signal,
    force: false,
  });
  return {
    smallSummary,
    rollup,
    created: true,
  };
}

function clearSummaryState(graph) {
  graph.summaryState = createDefaultSummaryState();
}

function getSliceDialogueRange(chat = [], slice = {}) {
  const directRange = normalizeRange(slice?.processedDialogueRange);
  if (directRange[0] >= 0 && directRange[1] >= 0) {
    return directRange;
  }
  return buildDialogueRangeFromMessageRange(chat, slice?.processedRange);
}

function getSuffixRebuildStartFromDialogueRange(
  graph,
  chat = [],
  targetDialogueRange = [-1, -1],
) {
  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: 0,
    currentExtractionCount: clampInt(
      graph?.historyState?.extractionCount,
      0,
      0,
      999999,
    ),
    currentRange: null,
    currentNodeIds: [],
    includeCurrentPending: false,
  });
  const affectedSlices = slices.filter((slice) =>
    intersectsRange(getSliceDialogueRange(chat, slice), targetDialogueRange),
  );
  if (affectedSlices.length === 0) {
    return null;
  }
  return {
    rebuildFromExtractionCount: Math.min(
      ...affectedSlices.map((slice) =>
        clampInt(slice.extractionCountBefore, 0, 0, 999999),
      ),
    ),
    affectedSlices,
  };
}

function resolveCurrentSummaryDialogueRange(graph, chat = []) {
  const activeEntries = getActiveSummaryEntries(graph);
  if (activeEntries.length > 0) {
    return getSummaryEntryDialogueRange(
      chat,
      activeEntries[activeEntries.length - 1],
    );
  }
  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: 0,
    currentExtractionCount: clampInt(
      graph?.historyState?.extractionCount,
      0,
      0,
      999999,
    ),
    currentRange: null,
    currentNodeIds: [],
    includeCurrentPending: false,
  });
  if (slices.length === 0) {
    return [-1, -1];
  }
  return getSliceDialogueRange(chat, slices[slices.length - 1]);
}

function trimSummaryStateForSuffixRebuild(graph, rebuildFromExtractionCount = 0) {
  normalizeGraphSummaryState(graph);
  const entries = Array.isArray(graph.summaryState?.entries)
    ? graph.summaryState.entries
    : [];
  const removeIds = entries
    .filter((entry) => {
      const extractionRange = normalizeRange(entry?.extractionRange);
      return extractionRange[1] >= rebuildFromExtractionCount;
    })
    .map((entry) => entry.id);
  const removedCount = removeSummaryEntriesByIds(graph, removeIds);
  const remainingEntries = Array.isArray(graph.summaryState?.entries)
    ? graph.summaryState.entries
    : [];
  graph.summaryState.lastSummarizedExtractionCount =
    remainingEntries.length > 0
      ? Math.max(
          0,
          ...remainingEntries.map((entry) =>
            normalizeRange(entry?.extractionRange)[1],
          ),
        )
      : Math.max(0, rebuildFromExtractionCount);
  graph.summaryState.lastSummarizedAssistantFloor =
    remainingEntries.length > 0
      ? Math.max(
          -1,
          ...remainingEntries.map((entry) =>
            normalizeRange(entry?.messageRange)[1],
          ),
        )
      : -1;
  return {
    removedCount,
  };
}

export async function rebuildHierarchicalSummaryState({
  graph,
  chat = [],
  settings = {},
  signal,
  mode = "current",
  startFloor = null,
  endFloor = null,
} = {}) {
  normalizeGraphSummaryState(graph);
  const currentExtractionCount = clampInt(
    graph?.historyState?.extractionCount,
    0,
    0,
    999999,
  );
  if (currentExtractionCount <= 0) {
    return {
      rebuilt: false,
      smallSummaryCount: 0,
      rollupCount: 0,
      reason: "Hiện vẫn chưa có lô trích xuất nào thành công",
    };
  }

  let targetDialogueRange = [-1, -1];
  if (String(mode || "current") === "range") {
    if (!Number.isFinite(Number(startFloor))) {
      return {
        rebuilt: false,
        smallSummaryCount: 0,
        rollupCount: 0,
        reason: "Khi xây lại theo phạm vi thì bắt buộc phải điền tầng bắt đầu",
      };
    }
    const latestDialogueFloor = buildDialogueFloorMap(chat).latestDialogueFloor;
    targetDialogueRange = [
      clampInt(startFloor, 0, 0, Math.max(0, latestDialogueFloor)),
      Number.isFinite(Number(endFloor))
        ? clampInt(endFloor, 0, 0, Math.max(0, latestDialogueFloor))
        : Math.max(0, latestDialogueFloor),
    ];
    targetDialogueRange[1] = Math.max(
      targetDialogueRange[0],
      targetDialogueRange[1],
    );
  } else {
    targetDialogueRange = resolveCurrentSummaryDialogueRange(graph, chat);
  }

  if (targetDialogueRange[0] < 0 || targetDialogueRange[1] < 0) {
    return {
      rebuilt: false,
      smallSummaryCount: 0,
      rollupCount: 0,
      reason: "Hiện không có phạm vi tổng kết nào có thể xây lại",
    };
  }

  const rebuildWindow = getSuffixRebuildStartFromDialogueRange(
    graph,
    chat,
    targetDialogueRange,
  );
  if (!rebuildWindow) {
    return {
      rebuilt: false,
      smallSummaryCount: 0,
      rollupCount: 0,
      reason: "Trong phạm vi mục tiêu không có lát cắt tổng kết nào khớp",
      targetDialogueRange,
    };
  }

  const trimmed = trimSummaryStateForSuffixRebuild(
    graph,
    rebuildWindow.rebuildFromExtractionCount,
  );

  const threshold = clampInt(settings.smallSummaryEveryNExtractions, 3, 1, 100);
  const slices = collectSlicesForSummaryWindow(graph, {
    lastSummarizedExtractionCount: rebuildWindow.rebuildFromExtractionCount,
    currentExtractionCount,
    currentRange: null,
    currentNodeIds: [],
    includeCurrentPending: false,
  });
  let pendingSlices = [];
  let smallSummaryCount = 0;
  let rollupCount = 0;

  for (const slice of slices) {
    pendingSlices.push(slice);
    if (pendingSlices.length < threshold) {
      continue;
    }

    const firstSlice = pendingSlices[0];
    const lastSlice = pendingSlices[pendingSlices.length - 1];
    const sourceNodeIds = uniqueIds(
      pendingSlices.flatMap((item) => item.touchedNodeIds || []),
    );
    const sourceMessages = buildSummarySourceMessages(
      chat,
      normalizeRange(firstSlice.processedRange)[0],
      normalizeRange(lastSlice.processedRange)[1],
      {
        rawChatContextFloors: getSummaryTaskInputConfig(settings, "synopsis")
          .rawChatContextFloors,
      },
    );
    if (sourceMessages.length > 0) {
      const nodeHints = collectNodeHints(graph, sourceNodeIds);
      const result = await callSummaryTask({
        settings,
        taskType: "synopsis",
        context: {
          recentMessages: buildTranscript(sourceMessages),
          chatMessages: sourceMessages,
          candidateText: buildNodeDigest(graph, sourceNodeIds) || "(KhôngNút then chốt hỗ trợ)",
          graphStats: [
            buildSummaryGraphStats(graph, getActiveSummaryEntries(graph)),
            `frontier_hint:\n${buildFrontierHint(graph)}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          currentRange: `Tầng ${sourceMessages[0]?.seq ?? "?"} ~ ${
            sourceMessages[sourceMessages.length - 1]?.seq ?? "?"
          }`,
        },
        fallbackSystemPrompt: [
          "Bạn là bộ sinh tóm tắt ngắn.",
          'đầu ra JSON: {"summary":"văn bản tóm tắt (80-220 ký tự)"}',
        ].join("\n"),
        fallbackUserPrompt: [
          "## Cửa sổ chat nguyên văn",
          buildTranscript(sourceMessages),
        ].join("\n"),
        signal,
      });
      const summaryText = String(result?.summary || "").trim();
      if (summaryText) {
        const entryMessageRange = [
          Number(sourceMessages[0]?.seq ?? -1),
          Number(sourceMessages[sourceMessages.length - 1]?.seq ?? -1),
        ];
        const entry = appendSummaryEntry(graph, {
          level: 0,
          kind: "small",
          status: "active",
          text: summaryText,
          sourceTask: "synopsis",
          extractionRange: [firstSlice.extractionCountAfter, lastSlice.extractionCountAfter],
          messageRange: entryMessageRange,
          dialogueRange: buildDialogueRangeFromMessageRange(chat, entryMessageRange),
          sourceBatchIds: pendingSlices.map((item) => item.id),
          sourceSummaryIds: [],
          sourceNodeIds,
          storyTimeSpan: deriveStoryTimeSpanFromNodes(
            graph,
            nodeHints.nodes,
            "derived",
          ),
          regionHints: nodeHints.regionHints,
          ownerHints: nodeHints.ownerHints,
        });
        graph.summaryState.lastSummarizedExtractionCount =
          lastSlice.extractionCountAfter;
        graph.summaryState.lastSummarizedAssistantFloor =
          normalizeRange(lastSlice.processedRange)[1];
        if (entry) smallSummaryCount += 1;
        const rollup = await rollupSummaryFrontier({
          graph,
          settings,
          signal,
          force: false,
        });
        rollupCount += Number(rollup?.createdCount || 0);
      }
    }
    pendingSlices = [];
  }

  return {
    rebuilt: smallSummaryCount > 0 || rollupCount > 0,
    smallSummaryCount,
    rollupCount,
    targetDialogueRange,
    rebuildFromExtractionCount: rebuildWindow.rebuildFromExtractionCount,
    removedEntryCount: trimmed.removedCount,
    reason:
      smallSummaryCount > 0 || rollupCount > 0
        ? ""
        : "Không thể xây lại chuỗi tổng kết mới từ các lô trích xuất hiện có",
  };
}

export function resetHierarchicalSummaryState(graph) {
  clearSummaryState(graph);
  return graph?.summaryState || null;
}
