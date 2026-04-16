// ST-BME: Trích xuất编排控制器（纯函数）
// 通过 runtime 依赖Tiêm，避免直接Lượt truy cập index.js 模块级Trạng thái。

import { debugLog } from "../runtime/debug-logging.js";
import {
  buildDialogueFloorMap,
  normalizeDialogueFloorRange,
} from "./chat-history.js";

function toSafeFloor(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
}

function clampIntValue(value, fallback = 0, min = 0, max = 9999) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function isAssistantFloor(runtime, chat, index) {
  if (!Array.isArray(chat)) return false;
  const message = chat[index];
  if (!message) return false;
  if (typeof runtime?.isAssistantChatMessage === "function") {
    return Boolean(
      runtime.isAssistantChatMessage(message, {
        index,
        chat,
      }),
    );
  }
  return Boolean(message) && !message.is_user && !message.is_system;
}

function getAssistantTurnsFallback(runtime, chat = []) {
  if (!Array.isArray(chat)) return [];
  const assistantTurns = [];
  for (let index = 0; index < chat.length; index++) {
    if (!isAssistantFloor(runtime, chat, index)) continue;
    if (!String(chat[index]?.mes ?? "").trim()) continue;
    assistantTurns.push(index);
  }
  return assistantTurns;
}

function normalizeSmartTriggerDecision(decision = null) {
  if (!decision || typeof decision !== "object") {
    return { triggered: false, score: 0, reasons: [] };
  }
  return {
    triggered: decision.triggered === true,
    score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : 0,
    reasons: Array.isArray(decision.reasons)
      ? decision.reasons.map((item) => String(item || "")).filter(Boolean)
      : [],
  };
}

function normalizePersistenceStateRecord(persistResult = null) {
  const accepted = persistResult?.accepted === true;
  const queued = persistResult?.queued === true;
  const blocked = persistResult?.blocked === true;
  let outcome = "failed";
  if (accepted && String(persistResult?.storageTier || "") === "indexeddb") {
    outcome = "saved";
  } else if (accepted) {
    outcome = "fallback";
  } else if (queued) {
    outcome = "queued";
  } else if (blocked) {
    outcome = "blocked";
  }

  return {
    outcome,
    accepted,
    storageTier: String(persistResult?.storageTier || "none"),
    reason: String(persistResult?.reason || ""),
    revision: Number.isFinite(Number(persistResult?.revision))
      ? Number(persistResult.revision)
      : 0,
    saveMode: String(persistResult?.saveMode || ""),
    recoverable: persistResult?.recoverable === true,
    saved: persistResult?.saved === true,
    queued,
    blocked,
    attempted: true,
  };
}

function hasMeaningfulPersistenceRecord(persistence = null) {
  if (!persistence || typeof persistence !== "object") return false;
  if (persistence.attempted === true) return true;
  const revision = Number(persistence?.revision || 0);
  if (Number.isFinite(revision) && revision > 0) return true;
  if (String(persistence?.storageTier || "").trim() && persistence.storageTier !== "none") {
    return true;
  }
  if (String(persistence?.saveMode || "").trim()) return true;
  if (String(persistence?.reason || "").trim()) return true;
  return (
    persistence.saved === true ||
    persistence.queued === true ||
    persistence.blocked === true
  );
}

function cloneSerializable(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function setExtractionProgressStatus(
  runtime,
  text,
  meta = "",
  level = "info",
  options = {},
) {
  if (typeof runtime?.setLastExtractionStatus === "function") {
    runtime.setLastExtractionStatus(text, meta, level, options);
    return;
  }
  if (options?.syncRuntime !== false && typeof runtime?.setRuntimeStatus === "function") {
    runtime.setRuntimeStatus(text, meta, level);
  }
}

function resolveLatestAssistantDialogueFloor(chat = []) {
  const map = buildDialogueFloorMap(chat);
  const assistantDialogueFloors = Array.isArray(map.assistantDialogueFloors)
    ? map.assistantDialogueFloors
    : [];
  return assistantDialogueFloors.length > 0
    ? assistantDialogueFloors[assistantDialogueFloors.length - 1]
    : null;
}

function resolveRerunDialogueTask(chat = [], options = {}) {
  const hasStart = Number.isFinite(Number(options?.startFloor));
  const hasEnd = Number.isFinite(Number(options?.endFloor));
  if (!hasStart && !hasEnd) {
    const latestAssistantDialogueFloor = resolveLatestAssistantDialogueFloor(chat);
    if (!Number.isFinite(Number(latestAssistantDialogueFloor))) {
      return {
        valid: false,
        reason: "Hiện không có可重提的 AI Phản hồi",
      };
    }
    const normalizedRange = normalizeDialogueFloorRange(
      chat,
      latestAssistantDialogueFloor,
      latestAssistantDialogueFloor,
    );
    return {
      ...normalizedRange,
      mode: "current",
      requestedStartFloor: null,
      requestedEndFloor: null,
    };
  }

  const normalizedRange = normalizeDialogueFloorRange(
    chat,
    options?.startFloor,
    options?.endFloor,
  );
  return {
    ...normalizedRange,
    mode: "range",
    requestedStartFloor: hasStart ? Number(options.startFloor) : null,
    requestedEndFloor: hasEnd ? Number(options.endFloor) : null,
  };
}

function resolveAssistantTargetRange(chat = [], dialogueRange = [-1, -1]) {
  const map = buildDialogueFloorMap(chat);
  const assistantDialogueFloors = Array.isArray(map.assistantDialogueFloors)
    ? map.assistantDialogueFloors
    : [];
  const assistantChatIndices = Array.isArray(map.assistantChatIndices)
    ? map.assistantChatIndices
    : [];
  const [startFloor, endFloor] = Array.isArray(dialogueRange)
    ? dialogueRange
    : [-1, -1];
  const targeted = [];

  for (let index = 0; index < assistantDialogueFloors.length; index += 1) {
    const floor = Number(assistantDialogueFloors[index]);
    const chatIndex = Number(assistantChatIndices[index]);
    if (!Number.isFinite(floor) || !Number.isFinite(chatIndex)) continue;
    if (floor < startFloor || floor > endFloor) continue;
    targeted.push({
      dialogueFloor: floor,
      chatIndex,
    });
  }

  return {
    map,
    targeted,
    startAssistantChatIndex: targeted.length > 0 ? targeted[0].chatIndex : null,
    endAssistantChatIndex:
      targeted.length > 0 ? targeted[targeted.length - 1].chatIndex : null,
    latestAssistantDialogueFloor:
      assistantDialogueFloors.length > 0
        ? assistantDialogueFloors[assistantDialogueFloors.length - 1]
        : null,
  };
}

function buildRerunFallbackInfo(chat = [], targetDialogueRange = [-1, -1]) {
  const assistantRange = resolveAssistantTargetRange(chat, targetDialogueRange);
  if (!assistantRange.targeted.length) {
    return {
      valid: false,
      reason: "目标Phạm vi内没有可重提的 AI Phản hồi",
      fallbackToLatest: false,
      ...assistantRange,
    };
  }

  const latestTargetedDialogueFloor = Number(
    assistantRange.targeted[assistantRange.targeted.length - 1]?.dialogueFloor,
  );
  const latestAssistantDialogueFloor = Number(
    assistantRange.latestAssistantDialogueFloor,
  );
  const fallbackToLatest =
    Number.isFinite(latestTargetedDialogueFloor) &&
    Number.isFinite(latestAssistantDialogueFloor) &&
    latestTargetedDialogueFloor < latestAssistantDialogueFloor;

  return {
    valid: true,
    reason: fallbackToLatest
      ? "đồ thị hiện tại对中段Phạm vi重提的后缀保留证据不足，已退化为从Tầng bắt đầu到最新重提"
      : "",
    fallbackToLatest,
    ...assistantRange,
  };
}

function buildCommittedBatchPersistSnapshot(
  runtime,
  {
    graph = null,
    chat = [],
    beforeSnapshot = null,
    processedRange = [null, null],
    postProcessArtifacts = [],
    vectorHashesInserted = [],
    extractionCountBefore = 0,
  } = {},
) {
  if (!graph || typeof runtime?.cloneGraphSnapshot !== "function") {
    return {
      persistGraphSnapshot: null,
      committedBatchJournalEntry: null,
      afterSnapshot: null,
      committedAfterSnapshot: null,
      postProcessArtifacts: Array.isArray(postProcessArtifacts)
        ? [...postProcessArtifacts]
        : [],
    };
  }

  const range = Array.isArray(processedRange) ? processedRange : [null, null];
  const rangeStart = Number.isFinite(Number(range[0])) ? Number(range[0]) : null;
  const rangeEnd = Number.isFinite(Number(range[1])) ? Number(range[1]) : null;
  const dialogueMap = buildDialogueFloorMap(chat);
  const processedDialogueRange = [
    Number.isFinite(Number(rangeStart))
      ? dialogueMap.chatIndexToFloor[rangeStart]
      : null,
    Number.isFinite(Number(rangeEnd))
      ? dialogueMap.chatIndexToFloor[rangeEnd]
      : null,
  ];
  const sourceChatIndexRange = [
    Number.isFinite(Number(rangeStart))
      ? Math.max(
          0,
          Number(rangeStart) -
            Math.max(
              0,
              Number(runtime?.getSettings?.()?.extractContextTurns) || 0,
            ) *
              2,
        )
      : null,
    rangeEnd,
  ];
  const afterSnapshot = runtime.cloneGraphSnapshot(graph);
  const effectiveArtifacts = Array.isArray(postProcessArtifacts)
    ? [...postProcessArtifacts]
    : [];
  const committedGraphSnapshot = runtime.cloneGraphSnapshot(graph);

  if (typeof runtime.applyProcessedHistorySnapshotToGraph === "function") {
    runtime.applyProcessedHistorySnapshotToGraph(
      committedGraphSnapshot,
      chat,
      rangeEnd,
    );
  } else {
    if (
      !committedGraphSnapshot.historyState ||
      typeof committedGraphSnapshot.historyState !== "object" ||
      Array.isArray(committedGraphSnapshot.historyState)
    ) {
      committedGraphSnapshot.historyState = {};
    }
    committedGraphSnapshot.historyState.lastProcessedAssistantFloor =
      Number.isFinite(rangeEnd) ? Math.floor(rangeEnd) : -1;
    committedGraphSnapshot.lastProcessedSeq =
      Number.isFinite(rangeEnd) ? Math.floor(rangeEnd) : -1;
  }

  const committedBatchJournalEntry =
    typeof runtime.createBatchJournalEntry === "function"
      ? runtime.createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
          processedRange: [rangeStart, rangeEnd],
          processedDialogueRange,
          sourceChatIndexRange,
          postProcessArtifacts: effectiveArtifacts,
          vectorHashesInserted: Array.isArray(vectorHashesInserted)
            ? vectorHashesInserted
            : [],
          extractionCountBefore,
        })
      : null;

  if (
    committedBatchJournalEntry &&
    typeof runtime.appendBatchJournal === "function"
  ) {
    runtime.appendBatchJournal(
      committedGraphSnapshot,
      cloneSerializable(committedBatchJournalEntry, committedBatchJournalEntry),
    );
  }

  return {
    persistDelta:
      typeof runtime.buildPersistDelta === "function"
        ? runtime.buildPersistDelta(beforeSnapshot, committedGraphSnapshot, {
            useNativeDelta: false,
          })
        : null,
    persistGraphSnapshot: committedGraphSnapshot,
    committedBatchJournalEntry,
    afterSnapshot,
    committedAfterSnapshot: runtime.cloneGraphSnapshot(committedGraphSnapshot),
    postProcessArtifacts: effectiveArtifacts,
  };
}

function isPersistenceRevisionAccepted(runtime, persistence = null) {
  if (!persistence || persistence.accepted === true) return true;
  const graphPersistenceState = runtime?.getGraphPersistenceState?.() || {};
  if (graphPersistenceState.pendingPersist === true) {
    return false;
  }
  const persistenceRevision = Number(persistence?.revision || 0);
  if (!Number.isFinite(persistenceRevision) || persistenceRevision <= 0) {
    return false;
  }
  const lastAcceptedRevision = Number(graphPersistenceState?.lastAcceptedRevision || 0);
  return Number.isFinite(lastAcceptedRevision) && lastAcceptedRevision >= persistenceRevision;
}

function getPendingPersistenceGateInfo(runtime) {
  const graph = runtime?.getCurrentGraph?.();
  const batchStatus = graph?.historyState?.lastBatchStatus || null;
  const persistence = batchStatus?.persistence || null;
  const pendingPersist = runtime?.getGraphPersistenceState?.()?.pendingPersist === true;
  const accepted = isPersistenceRevisionAccepted(runtime, persistence);
  const attempted = hasMeaningfulPersistenceRecord(persistence);
  if (!pendingPersist && (!attempted || accepted)) {
    return null;
  }

  return {
    pendingPersist,
    accepted,
    attempted,
    outcome: String(persistence?.outcome || ""),
    reason: String(persistence?.reason || ""),
    revision: Number.isFinite(Number(persistence?.revision))
      ? Number(persistence.revision)
      : 0,
  };
}

async function maybeRetryPendingPersistence(runtime, reason = "pending-persist-retry") {
  const gate = getPendingPersistenceGateInfo(runtime);
  if (!gate || typeof runtime?.retryPendingGraphPersist !== "function") {
    return gate;
  }

  try {
    const retryResult = await runtime.retryPendingGraphPersist({ reason });
    if (retryResult?.accepted === true) {
      return null;
    }
  } catch (error) {
    runtime?.console?.warn?.("[ST-BME] pending persistence retry failed", error);
  }

  return getPendingPersistenceGateInfo(runtime);
}

function formatPendingPersistenceGateMessage(runtime, operationLabel = "当前Trích xuất") {
  const gate = getPendingPersistenceGateInfo(runtime);
  if (!gate) return "";
  const reason = gate.reason ? ` · ${gate.reason}` : "";
  const revision =
    Number.isFinite(Number(gate.revision)) && Number(gate.revision) > 0
      ? ` · rev ${Number(gate.revision)}`
      : "";
  return `${operationLabel}Đã tạm dừng：上一批Lưu bền尚Chưa xác nhận，请先使用“Thử lưu bền lại”或“Thăm dò lại đồ thị”${revision}${reason}`;
}

export function resolveAutoExtractionPlanController(
  runtime,
  {
    chat = null,
    settings = null,
    lastProcessedAssistantFloor = null,
    lockedEndFloor = null,
  } = {},
) {
  const resolvedChat = Array.isArray(chat)
    ? chat
    : runtime?.getContext?.()?.chat || [];
  const resolvedSettings =
    settings && typeof settings === "object"
      ? settings
      : runtime?.getSettings?.() || {};
  const safeLastProcessedAssistantFloor = toSafeFloor(
    lastProcessedAssistantFloor,
    toSafeFloor(runtime?.getLastProcessedAssistantFloor?.(), -1),
  );
  const safeLockedEndFloor = toSafeFloor(lockedEndFloor, null);
  const strategy =
    resolvedSettings.extractAutoDelayLatestAssistant === true
      ? "lag-one-assistant"
      : "normal";
  const extractEvery = clampIntValue(
    resolvedSettings.extractEvery,
    1,
    1,
    50,
  );
  const assistantTurns =
    typeof runtime?.getAssistantTurns === "function"
      ? runtime.getAssistantTurns(resolvedChat)
      : getAssistantTurnsFallback(runtime, resolvedChat);
  const pendingAssistantTurns = assistantTurns.filter(
    (floor) => floor > safeLastProcessedAssistantFloor,
  );
  const candidateAssistantTurns =
    safeLockedEndFloor == null
      ? pendingAssistantTurns
      : pendingAssistantTurns.filter((floor) => floor <= safeLockedEndFloor);

  let eligibleAssistantTurns = candidateAssistantTurns;
  let waitingForNextAssistant = false;
  if (safeLockedEndFloor == null && strategy === "lag-one-assistant") {
    if (candidateAssistantTurns.length <= 1) {
      eligibleAssistantTurns = [];
      waitingForNextAssistant = candidateAssistantTurns.length === 1;
    } else {
      eligibleAssistantTurns = candidateAssistantTurns.slice(0, -1);
    }
  }

  const eligibleEndFloor =
    eligibleAssistantTurns.length > 0
      ? eligibleAssistantTurns[eligibleAssistantTurns.length - 1]
      : null;
  const smartTriggerDecision =
    resolvedSettings.enableSmartTrigger && eligibleEndFloor != null
      ? normalizeSmartTriggerDecision(
          runtime?.getSmartTriggerDecision?.(
            resolvedChat,
            safeLastProcessedAssistantFloor,
            resolvedSettings,
            eligibleEndFloor,
          ),
        )
      : { triggered: false, score: 0, reasons: [] };
  const meetsExtractEvery = eligibleAssistantTurns.length >= extractEvery;
  const canRun =
    eligibleAssistantTurns.length > 0 &&
    (meetsExtractEvery || smartTriggerDecision.triggered);
  const batchAssistantTurns = canRun
    ? smartTriggerDecision.triggered
      ? eligibleAssistantTurns
      : eligibleAssistantTurns.slice(0, extractEvery)
    : [];
  const plannedBatchEndFloor =
    batchAssistantTurns.length > 0
      ? batchAssistantTurns[batchAssistantTurns.length - 1]
      : null;

  let reason = "";
  if (pendingAssistantTurns.length === 0) {
    reason = "no-unprocessed-assistant-turns";
  } else if (candidateAssistantTurns.length === 0) {
    reason =
      safeLockedEndFloor == null
        ? "no-candidate-assistant-turns"
        : "locked-target-missing";
  } else if (waitingForNextAssistant) {
    reason = "waiting-next-assistant";
  } else if (!canRun && !smartTriggerDecision.triggered) {
    reason = "below-extract-every";
  }

  return {
    strategy,
    chat: resolvedChat,
    settings: resolvedSettings,
    lastProcessedAssistantFloor: safeLastProcessedAssistantFloor,
    lockedEndFloor: safeLockedEndFloor,
    extractEvery,
    pendingAssistantTurns,
    candidateAssistantTurns,
    eligibleAssistantTurns,
    eligibleEndFloor,
    waitingForNextAssistant,
    smartTriggerDecision,
    meetsExtractEvery,
    canRun,
    batchAssistantTurns,
    plannedBatchEndFloor,
    startIdx: batchAssistantTurns[0] ?? null,
    endIdx: plannedBatchEndFloor,
    reason,
  };
}

export async function executeExtractionBatchController(
  runtime,
  {
    chat,
    startIdx,
    endIdx,
    settings,
    smartTriggerDecision = null,
    signal = undefined,
  } = {},
) {
  runtime.ensureCurrentGraphRuntimeState();
  runtime.throwIfAborted(signal, "Trích xuấtĐã chấm dứt");

  const currentGraph = runtime.getCurrentGraph();
  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const extractionCountBefore = runtime.getExtractionCount();
  const beforeSnapshot = runtime.cloneGraphSnapshot(currentGraph);
  const messages = runtime.buildExtractionMessages(chat, startIdx, endIdx, settings);
  const batchStatus = runtime.createBatchStatusSkeleton({
    processedRange: [startIdx, endIdx],
    extractionCountBefore,
  });

  debugLog(
    `[ST-BME] 开始Trích xuất: tầng ${startIdx}-${endIdx}` +
      (smartTriggerDecision?.triggered
        ? ` [智能触发 score=${smartTriggerDecision.score}; ${smartTriggerDecision.reasons.join(" / ")}]`
        : ""),
  );

  const result = await runtime.extractMemories({
    graph: currentGraph,
    messages,
    startSeq: startIdx,
    endSeq: endIdx,
    lastProcessedSeq: lastProcessed,
    schema: runtime.getSchema(),
    embeddingConfig: runtime.getEmbeddingConfig(),
    extractPrompt: undefined,
    settings,
    signal,
    onStreamProgress: ({ previewText, receivedChars }) => {
      const preview =
        previewText?.length > 60 ? "…" + previewText.slice(-60) : previewText || "";
      runtime.setLastExtractionStatus(
        "AI 生成中",
        `${preview}  [${receivedChars}字]`,
        "running",
        { noticeMarquee: true },
      );
    },
  });

  if (!result.success) {
    runtime.setBatchStageOutcome(
      batchStatus,
      "core",
      "failed",
      result?.error || "Trích xuất阶段未返回有效Thao tác",
    );
    runtime.setBatchStageOutcome(
      batchStatus,
      "finalize",
      "failed",
      "Trích xuất阶段Thất bại，未进入Lưu bền",
    );
    batchStatus.persistence = null;
    batchStatus.historyAdvanceAllowed = false;
    batchStatus.historyAdvanced = false;
    runtime.finalizeBatchStatus(batchStatus, runtime.getExtractionCount());
    runtime.getCurrentGraph().historyState.lastBatchStatus = batchStatus;
    return {
      success: false,
      result,
      effects: null,
      batchStatus,
      error: result?.error || "Trích xuất阶段未返回有效Thao tác",
    };
  }

  runtime.setBatchStageOutcome(batchStatus, "core", "success");
  const effects = await runtime.handleExtractionSuccess(
    result,
    endIdx,
    settings,
    signal,
    batchStatus,
  );
  const batchStatusRef = effects?.batchStatus || batchStatus;
  const committedPersistState = buildCommittedBatchPersistSnapshot(runtime, {
    graph: runtime.getCurrentGraph(),
    chat,
    beforeSnapshot,
    processedRange: [startIdx, endIdx],
    postProcessArtifacts: runtime.computePostProcessArtifacts(
      beforeSnapshot,
      runtime.cloneGraphSnapshot(runtime.getCurrentGraph()),
      effects?.postProcessArtifacts || [],
    ),
    vectorHashesInserted: effects?.vectorHashesInserted || [],
    extractionCountBefore,
  });
  const persistResult = await runtime.persistExtractionBatchResult({
    reason: "extraction-batch-complete",
    lastProcessedAssistantFloor: endIdx,
    graphSnapshot: committedPersistState.persistGraphSnapshot,
    persistDelta: committedPersistState.persistDelta,
  });
  const persistence = normalizePersistenceStateRecord(persistResult);
  batchStatusRef.persistence = persistence;
  batchStatusRef.historyAdvanceAllowed = persistence.accepted === true;
  const finalizedBatchStatus = runtime.finalizeBatchStatus(
    batchStatusRef,
    runtime.getExtractionCount(),
  );

  runtime.getCurrentGraph().historyState.lastBatchStatus = {
    ...finalizedBatchStatus,
    persistence,
    historyAdvanceAllowed: persistence.accepted === true,
    historyAdvanced: runtime.shouldAdvanceProcessedHistory({
      ...finalizedBatchStatus,
      historyAdvanceAllowed: persistence.accepted === true,
    }),
  };

  if (runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanced) {
    runtime.updateProcessedHistorySnapshot(chat, endIdx);
    if (committedPersistState.committedBatchJournalEntry) {
      runtime.appendBatchJournal(
        runtime.getCurrentGraph(),
        cloneSerializable(
          committedPersistState.committedBatchJournalEntry,
          committedPersistState.committedBatchJournalEntry,
        ),
      );
    }
  } else if (!persistence.accepted) {
    runtime.setLastExtractionStatus(
      "Trích xuất待Khôi phục",
      `tầng ${startIdx}-${endIdx} 已抽取，但Trạng thái lưu bền为 ${persistence.outcome || "failed"}${persistence.reason ? ` · ${persistence.reason}` : ""}`,
      "warning",
      { syncRuntime: true },
    );
    runtime.console?.warn?.("[ST-BME] extraction persist not accepted", {
      chatId: runtime.getGraphPersistenceState?.()?.chatId || "",
      persistence,
      processedRange: [startIdx, endIdx],
    });
  }

  return {
    success: finalizedBatchStatus.completed,
    result,
    effects: {
      ...(effects || {}),
      persistResult,
    },
    batchStatus: finalizedBatchStatus,
    persistResult,
    historyAdvanceAllowed: persistence.accepted === true,
    error: finalizedBatchStatus.completed
      ? ""
      : effects?.vectorError ||
        finalizedBatchStatus.errors?.[0] ||
        "批lần未Hoàn tất finalize 闭环",
  };
}

export async function runExtractionController(runtime, options = {}) {
  const lockedEndFloor = toSafeFloor(options?.lockedEndFloor, null);
  const triggerSource = String(options?.triggerSource || "auto").trim() || "auto";
  const settings = runtime.getSettings?.() || {};
  const context = runtime.getContext?.() || {};
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const plan = resolveAutoExtractionPlanController(runtime, {
    chat,
    settings,
    lockedEndFloor,
  });
  const deferredTargetEndFloor =
    plan.plannedBatchEndFloor ?? lockedEndFloor;

  if (runtime.getIsExtracting()) {
    runtime.console?.debug?.("[ST-BME] auto extraction deferred: extraction already in progress");
    runtime.deferAutoExtraction?.("extracting", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    return;
  }

  if (!settings.enabled) return;
  if (!runtime.ensureGraphMutationReady("Tự độngTrích xuất", { notify: false })) {
    runtime.console?.debug?.("[ST-BME] auto extraction blocked: graph-not-ready", {
      loadState: runtime.getGraphPersistenceState?.()?.loadState || "",
    });
    runtime.deferAutoExtraction?.("graph-not-ready", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    runtime.setLastExtractionStatus(
      "Đang chờđồ thị加载",
      runtime.getGraphMutationBlockReason("Tự độngTrích xuất"),
      "warning",
      { syncRuntime: true },
    );
    return;
  }

  const pendingPersistGate = await maybeRetryPendingPersistence(
    runtime,
    "auto-extraction-persist-retry",
  );
  const pendingPersistMessage = pendingPersistGate
    ? formatPendingPersistenceGateMessage(runtime, "Tự độngTrích xuất")
    : "";
  if (pendingPersistMessage) {
    runtime.console?.debug?.("[ST-BME] auto extraction paused: pending persistence", {
      persistence: runtime.getCurrentGraph?.()?.historyState?.lastBatchStatus?.persistence || null,
    });
    runtime.deferAutoExtraction?.("pending-persist", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    runtime.setLastExtractionStatus(
      "Đang chờLưu bềnXác nhận",
      pendingPersistMessage,
      "warning",
      { syncRuntime: true },
    );
    return;
  }

  if (!runtime.getCurrentGraph()) {
    runtime.ensureCurrentGraphRuntimeState?.();
  }

  if (!(await runtime.recoverHistoryIfNeeded("auto-extract"))) {
    runtime.console?.debug?.("[ST-BME] auto extraction paused during history recovery", {
      recovering: runtime.getIsRecoveringHistory?.() === true,
    });
    if (runtime.getIsRecoveringHistory?.()) {
      runtime.deferAutoExtraction?.("history-recovering", {
        targetEndFloor: deferredTargetEndFloor,
        strategy: plan.strategy,
      });
    }
    return;
  }

  if (!chat || chat.length === 0) return;
  if (!plan.canRun || plan.startIdx == null || plan.endIdx == null) {
    return;
  }

  const startIdx = plan.startIdx;
  const endIdx = plan.endIdx;
  const smartTriggerDecision = plan.smartTriggerDecision;
  runtime.setIsExtracting(true);
  const extractionController = runtime.beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  runtime.setLastExtractionStatus(
    "Trích xuất中",
    `tầng ${startIdx}-${endIdx}${smartTriggerDecision.triggered ? " · 智能触发" : ""}${triggerSource !== "auto" ? ` · ${triggerSource}` : ""}`,
    "running",
    { syncRuntime: true },
  );

  try {
    const batchResult = await runtime.executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      smartTriggerDecision,
      signal: extractionSignal,
    });

    if (!batchResult.success) {
      const message =
        batchResult.error ||
        batchResult?.result?.error ||
        "Trích xuất批lần未返回有效Kết quả";
      runtime.console.warn("[ST-BME] Trích xuất批lần未返回有效Kết quả:", message);
      runtime.notifyExtractionIssue(message);
      return;
    }

    const persistence = batchResult.batchStatus?.persistence || null;
    if (batchResult.historyAdvanceAllowed === false) {
      runtime.setLastExtractionStatus(
        "Trích xuấtHoàn tất，Lưu bềnChờ xác nhận",
        `tầng ${startIdx}-${endIdx} · Tạo mới ${batchResult.result?.newNodes || 0} · Cập nhật ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}${persistence?.reason ? ` · ${persistence.reason}` : ""}`,
        "warning",
        { syncRuntime: true },
      );
    } else {
      runtime.setLastExtractionStatus(
        "Trích xuấtHoàn tất",
        `tầng ${startIdx}-${endIdx} · Tạo mới ${batchResult.result?.newNodes || 0} · Cập nhật ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}`,
        "success",
        { syncRuntime: true },
      );
    }
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setLastExtractionStatus(
        "Trích xuấtĐã chấm dứt",
        e?.message || "已Thủ công终止当前Trích xuất",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    runtime.console.error("[ST-BME] Trích xuấtThất bại:", e);
    runtime.notifyExtractionIssue(e?.message || String(e) || "Tự độngTrích xuấtThất bại");
  } finally {
    runtime.finishStageAbortController("extraction", extractionController);
    runtime.setIsExtracting(false);
  }
}

export async function onManualExtractController(runtime, options = {}) {
  if (runtime.getIsExtracting()) {
    runtime.toastr.info("Ký ứcTrích xuất正在进行中，请稍候");
    return;
  }
  const taskLabel = String(options?.taskLabel || "Thủ côngTrích xuất").trim() || "Thủ côngTrích xuất";
  const toastTitle = String(options?.toastTitle || `ST-BME ${taskLabel}`).trim() ||
    `ST-BME ${taskLabel}`;
  const showStartToast = options?.showStartToast !== false;
  const lockedEndFloor = toSafeFloor(options?.lockedEndFloor, null);
  if (!runtime.ensureGraphMutationReady(taskLabel)) return;
  const pendingPersistGate = await maybeRetryPendingPersistence(
    runtime,
    "manual-extraction-persist-retry",
  );
  const pendingPersistMessage = pendingPersistGate
    ? formatPendingPersistenceGateMessage(runtime, taskLabel)
    : "";
  if (pendingPersistMessage) {
    runtime.setLastExtractionStatus(
      "Đang chờLưu bềnXác nhận",
      pendingPersistMessage,
      "warning",
      {
        syncRuntime: true,
      },
    );
    runtime.toastr.warning("上一批Lưu bền尚Chưa xác nhận，请先点“Thử lưu bền lại”或“Thăm dò lại đồ thị”");
    return;
  }
  if (!(await runtime.recoverHistoryIfNeeded("manual-extract"))) return;
  if (!runtime.getCurrentGraph()) {
    runtime.setCurrentGraph(
      runtime.normalizeGraphRuntimeState(
        runtime.createEmptyGraph(),
        runtime.getCurrentChatId(),
      ),
    );
  }

  const context = runtime.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    runtime.toastr.info("Chat hiện tại为空，暂Không可Trích xuấtNội dung");
    return;
  }

  const assistantTurns = runtime.getAssistantTurns(chat);
  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const pendingAssistantTurns = assistantTurns.filter((i) => i > lastProcessed);
  const targetAssistantTurns = pendingAssistantTurns.filter((i) => {
    if (lockedEndFloor != null && i > lockedEndFloor) return false;
    return true;
  });
  if (pendingAssistantTurns.length === 0) {
    runtime.toastr.info("没有待Trích xuất的新Phản hồi");
    return;
  }

  const settings = runtime.getSettings();
  const extractEvery = runtime.clampInt(settings.extractEvery, 1, 1, 50);
  const totals = {
    newNodes: 0,
    updatedNodes: 0,
    newEdges: 0,
    batches: 0,
  };
  let processedAssistantTurns = 0;
  const warnings = [];

  runtime.setIsExtracting(true);
  const extractionController = runtime.beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  setExtractionProgressStatus(
    runtime,
    `${taskLabel}中`,
    lockedEndFloor != null
      ? `待Xử lý AI Phản hồi ${targetAssistantTurns.length} 条 · 截止 chatIndex ${lockedEndFloor}`
      : `待Xử lý AI Phản hồi ${targetAssistantTurns.length} 条`,
    "running",
    {
      syncRuntime: true,
      toastKind: showStartToast ? "info" : "",
      toastTitle,
    },
  );
  try {
    while (true) {
      const pendingTurns = runtime
        .getAssistantTurns(chat)
        .filter((i) => {
          if (i <= runtime.getLastProcessedAssistantFloor()) return false;
          if (lockedEndFloor != null && i > lockedEndFloor) return false;
          return true;
        });
      if (pendingTurns.length === 0) break;

      const batchAssistantTurns = pendingTurns.slice(0, extractEvery);
      const startIdx = batchAssistantTurns[0];
      const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];
      const batchResult = await runtime.executeExtractionBatch({
        chat,
        startIdx,
        endIdx,
        settings,
        signal: extractionSignal,
      });

      if (!batchResult.success) {
        throw new Error(
          batchResult.error ||
            batchResult?.result?.error ||
            "Thủ côngTrích xuất未返回有效Kết quả",
        );
      }

      totals.newNodes += batchResult.result.newNodes || 0;
      totals.updatedNodes += batchResult.result.updatedNodes || 0;
      totals.newEdges += batchResult.result.newEdges || 0;
      totals.batches++;
      processedAssistantTurns += batchAssistantTurns.length;

      if (Array.isArray(batchResult.effects?.warnings)) {
        warnings.push(...batchResult.effects.warnings);
      }

      const totalTurnsForDisplay = Math.max(
        processedAssistantTurns,
        targetAssistantTurns.length,
      );
      setExtractionProgressStatus(
        runtime,
        `${taskLabel}中`,
        totalTurnsForDisplay > 0
          ? `已Xử lý ${processedAssistantTurns}/${totalTurnsForDisplay} 条 AI Phản hồi · 当前tầng ${startIdx}-${endIdx} · 累计 ${totals.batches} 批`
          : `当前tầng ${startIdx}-${endIdx} · 累计 ${totals.batches} 批`,
        "running",
        {
          syncRuntime: true,
          toastKind: "",
          toastTitle,
        },
      );

      if (batchResult.historyAdvanceAllowed === false) {
        warnings.push(
          batchResult.batchStatus?.persistence?.reason ||
            "当前批lầnLưu bền尚Chưa xác nhận",
        );
        break;
      }

      if (options?.drainAll === false) {
        break;
      }
    }

    if (totals.batches === 0) {
      setExtractionProgressStatus(
        runtime,
        "Không待Trích xuấtNội dung",
        lockedEndFloor != null
          ? "指定Phạm vi内没有新的 assistant Phản hồi需要Xử lý"
          : "没有新的 assistant Phản hồi需要Xử lý",
        "info",
        {
          syncRuntime: true,
        },
      );
      runtime.toastr.info("没有待Trích xuất的新Phản hồi");
      return;
    }

    const pendingAfterRun = getPendingPersistenceGateInfo(runtime);
    if (pendingAfterRun) {
      runtime.toastr.warning(
        `Trích xuấtHoàn tất但Lưu bềnChờ xác nhận：${pendingAfterRun.reason || pendingAfterRun.outcome || "unknown"}`,
      );
      runtime.setLastExtractionStatus(
        `${taskLabel}Hoàn tất，Lưu bềnChờ xác nhận`,
        `${totals.batches} 批 · Tạo mới ${totals.newNodes} · Cập nhật ${totals.updatedNodes} · 新边 ${totals.newEdges}${pendingAfterRun.reason ? ` · ${pendingAfterRun.reason}` : ""}`,
        "warning",
        {
          syncRuntime: true,
          toastKind: "",
          toastTitle,
        },
      );
    } else {
      runtime.toastr.success(
        `Trích xuấtHoàn tất：${totals.batches} 批，Tạo mới ${totals.newNodes}, cập nhật ${totals.updatedNodes}，新边 ${totals.newEdges}`,
      );
      runtime.setLastExtractionStatus(
        `${taskLabel}Hoàn tất`,
        `${totals.batches} 批 · Tạo mới ${totals.newNodes} · Cập nhật ${totals.updatedNodes} · 新边 ${totals.newEdges}`,
        "success",
        {
          syncRuntime: true,
          toastKind: "success",
          toastTitle,
        },
      );
    }
    if (warnings.length > 0) {
      runtime.toastr.warning(warnings.slice(0, 2).join("；"), "ST-BME Trích xuấtCảnh báo", {
        timeOut: 5000,
      });
    }
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setLastExtractionStatus(
        `${taskLabel}Đã chấm dứt`,
        e?.message || "已Thủ công终止当前Trích xuất",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    runtime.console.error("[ST-BME] Thủ côngTrích xuấtThất bại:", e);
    runtime.setLastExtractionStatus(`${taskLabel}Thất bại`, e?.message || String(e), "error", {
      syncRuntime: true,
      toastKind: "",
      toastTitle,
    });
    runtime.toastr.error(`${taskLabel}Thất bại: ${e.message || e}`);
  } finally {
    runtime.finishStageAbortController("extraction", extractionController);
    runtime.setIsExtracting(false);
    runtime.refreshPanelLiveState();
  }
}

export async function onExtractionTaskController(runtime, options = {}) {
  const requestedMode = String(options?.mode || "pending").trim().toLowerCase();
  const context = runtime.getContext?.() || {};
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const runManualExtract = async (manualOptions = {}) => {
    if (typeof runtime?.onManualExtract === "function") {
      return await runtime.onManualExtract(manualOptions);
    }
    return await onManualExtractController(runtime, manualOptions);
  };

  if (requestedMode === "pending") {
    return await runManualExtract({
      ...options,
      taskLabel: "Trích xuất phần chưa xử lý",
      toastTitle: "ST-BME Trích xuất lại",
    });
  }

  const rerunTask = resolveRerunDialogueTask(chat, options);
  if (!rerunTask.valid) {
    runtime.toastr?.info?.(rerunTask.reason || "Hiện không có可重提的Phạm vi");
    return {
      success: false,
      rerunPerformed: false,
      fallbackToLatest: false,
      requestedRange: [null, null],
      effectiveDialogueRange: [null, null],
      reason: rerunTask.reason || "invalid-rerun-range",
    };
  }

  const fallbackInfo = buildRerunFallbackInfo(chat, [
    rerunTask.startFloor,
    rerunTask.endFloor,
  ]);
  if (!fallbackInfo.valid) {
    runtime.toastr?.info?.(fallbackInfo.reason || "目标Phạm vi内没有可重提的 AI Phản hồi");
    return {
      success: false,
      rerunPerformed: false,
      fallbackToLatest: false,
      requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
      effectiveDialogueRange: [rerunTask.startFloor, rerunTask.endFloor],
      reason: fallbackInfo.reason || "no-assistant-in-range",
    };
  }

  const effectiveLockedEndFloor = fallbackInfo.fallbackToLatest
    ? null
    : fallbackInfo.endAssistantChatIndex;
  const effectiveDialogueRange = [
    rerunTask.startFloor,
    fallbackInfo.fallbackToLatest
      ? Number.isFinite(Number(fallbackInfo.latestAssistantDialogueFloor))
        ? Number(fallbackInfo.latestAssistantDialogueFloor)
        : rerunTask.endFloor
      : rerunTask.endFloor,
  ];

  setExtractionProgressStatus(
    runtime,
    "Trích xuất lại准备中",
    fallbackInfo.fallbackToLatest
      ? `Phạm vi ${rerunTask.startFloor} ~ ${rerunTask.endFloor} 命中旧批lần，但当前将退化为从 ${effectiveDialogueRange[0]} 到最新重提`
      : `准备重提Phạm vi ${rerunTask.startFloor} ~ ${rerunTask.endFloor}`,
    fallbackInfo.fallbackToLatest ? "warning" : "running",
    {
      syncRuntime: true,
      toastKind: "info",
      toastTitle: "ST-BME Trích xuất lại",
    },
  );

  const rollbackResult = await runtime.rollbackGraphForReroll(
    fallbackInfo.startAssistantChatIndex,
    context,
  );
  if (!rollbackResult?.success) {
    const rollbackError = String(
      rollbackResult?.error ||
        rollbackResult?.reason ||
        rollbackResult?.recoveryPath ||
        "回滚Thất bại",
    ).trim() || "回滚Thất bại";
    setExtractionProgressStatus(
      runtime,
      "Trích xuất lạiThất bại",
      rollbackError,
      "warning",
      {
        syncRuntime: true,
        toastKind: "",
        toastTitle: "ST-BME Trích xuất lại",
      },
    );
    runtime.toastr?.warning?.(
      `Trích xuất lại未开始：${rollbackError}`,
      "ST-BME Trích xuất lại",
      {
        timeOut: 4500,
      },
    );
    return {
      ...rollbackResult,
      rerunPerformed: false,
      fallbackToLatest: fallbackInfo.fallbackToLatest,
      requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
      effectiveDialogueRange,
    };
  }

  if (fallbackInfo.reason) {
    runtime.toastr?.warning?.(fallbackInfo.reason, "ST-BME Trích xuất lại", {
      timeOut: 3500,
    });
  }

  const rollbackDesc =
    rollbackResult.effectiveFromFloor !== fallbackInfo.startAssistantChatIndex
      ? `已按批lần边界回滚到tầng ${rollbackResult.effectiveFromFloor}，正在开始Trích xuất lại`
      : `已回滚到tầng ${fallbackInfo.startAssistantChatIndex}，正在开始Trích xuất lại`;
  setExtractionProgressStatus(
    runtime,
    "Trích xuất lại中",
    rollbackDesc,
    "running",
    {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME Trích xuất lại",
    },
  );

  await runManualExtract({
    drainAll: true,
    lockedEndFloor: effectiveLockedEndFloor,
    taskLabel: "Trích xuất lại",
    toastTitle: "ST-BME Trích xuất lại",
    showStartToast: false,
  });

  return {
    success: true,
    rerunPerformed: true,
    fallbackToLatest: fallbackInfo.fallbackToLatest,
    requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
    effectiveDialogueRange,
    effectiveAssistantChatRange: [
      fallbackInfo.startAssistantChatIndex,
      effectiveLockedEndFloor,
    ],
    rollbackResult,
    reason: fallbackInfo.reason || "",
  };
}

export async function onRerollController(runtime, { fromFloor } = {}) {
  if (runtime.getIsExtracting?.()) {
    runtime.toastr?.info?.("Ký ứcTrích xuất正在进行中，请稍候");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "busy",
      affectedBatchCount: 0,
      error: "Ký ứcTrích xuất正在进行中",
    };
  }

  if (
    typeof runtime.ensureGraphMutationReady === "function" &&
    !runtime.ensureGraphMutationReady("Trích xuất lại")
  ) {
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: Number.isFinite(fromFloor) ? fromFloor : null,
      effectiveFromFloor: null,
      recoveryPath: runtime.getGraphPersistenceState?.()?.loadState || "graph-not-ready",
      affectedBatchCount: 0,
      error:
        typeof runtime.getGraphMutationBlockReason === "function"
          ? runtime.getGraphMutationBlockReason("Trích xuất lại")
          : "Trích xuất lạiĐã tạm dừng：đồ thị尚未就绪。",
    };
  }

  if (!runtime.getCurrentGraph?.()) {
    runtime.toastr?.info?.("đồ thị为空，Không需重 Roll");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-graph",
      affectedBatchCount: 0,
      error: "đồ thị为空",
    };
  }

  const context = runtime.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    runtime.toastr?.info?.("Chat hiện tại为空");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-chat",
      affectedBatchCount: 0,
      error: "Chat hiện tại为空",
    };
  }

  let targetFloor = Number.isFinite(fromFloor) ? fromFloor : null;
  if (targetFloor === null) {
    const assistantTurns = runtime.getAssistantTurns(chat);
    if (assistantTurns.length === 0) {
      runtime.toastr?.info?.("聊天中没有 AI Phản hồi");
      return {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: null,
        effectiveFromFloor: null,
        recoveryPath: "no-assistant-turn",
        affectedBatchCount: 0,
        error: "聊天中没有 AI Phản hồi",
      };
    }
    targetFloor = assistantTurns[assistantTurns.length - 1];
  }

  setExtractionProgressStatus(
    runtime,
    "Trích xuất lại准备中",
    Number.isFinite(targetFloor)
      ? `准备从tầng ${targetFloor} 开始回滚并Trích xuất lại`
      : "准备回滚最新 AI 楼并Trích xuất lại",
    "running",
    {
      syncRuntime: true,
      toastKind: "info",
      toastTitle: "ST-BME 重 Roll",
    },
  );

  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const alreadyExtracted = targetFloor <= lastProcessed;

  if (!alreadyExtracted) {
    runtime.toastr?.info?.("该tầng尚未Trích xuất，直接执行Trích xuất…", "ST-BME 重 Roll", {
      timeOut: 2000,
    });
    await runtime.onManualExtract();
    return {
      success: true,
      rollbackPerformed: false,
      extractionTriggered: true,
      requestedFloor: targetFloor,
      effectiveFromFloor: lastProcessed + 1,
      recoveryPath: "direct-extract",
      affectedBatchCount: 0,
      extractionStatus: runtime.getLastExtractionStatusLevel?.() || "idle",
      error: "",
    };
  }

  debugLog(`[ST-BME] 重 Roll 开始，目标tầng: ${targetFloor}`);
  let rollbackResult;
  try {
    rollbackResult = await runtime.rollbackGraphForReroll(targetFloor, context);
  } catch (e) {
    if (runtime.isAbortError(e)) {
      setExtractionProgressStatus(
        runtime,
        "Trích xuất lại已Hủy",
        e.message || "聊天已切换",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: targetFloor,
        effectiveFromFloor: null,
        recoveryPath: "aborted",
        affectedBatchCount: 0,
        error: e.message || "聊天已切换，Trích xuất lại已Hủy",
      };
    }
    throw e;
  }

  if (!rollbackResult?.success) {
    setExtractionProgressStatus(
      runtime,
      "Trích xuất lạiThất bại",
      rollbackResult.error || "回滚Thất bại",
      "error",
      {
        syncRuntime: true,
      },
    );
    runtime.toastr?.error?.(rollbackResult.error, "ST-BME 重 Roll");
    return rollbackResult;
  }

  const rerollDesc =
    rollbackResult.effectiveFromFloor !== targetFloor
      ? `已按批lần边界回滚到tầng ${rollbackResult.effectiveFromFloor} 开始Trích xuất lại…`
      : `已回滚到tầng ${targetFloor} 开始Trích xuất lại…`;
  runtime.toastr?.info?.(rerollDesc, "ST-BME 重 Roll", {
    timeOut: 2500,
  });

  setExtractionProgressStatus(
    runtime,
    "Trích xuất lại中",
    rerollDesc,
    "running",
    {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME 重 Roll",
    },
  );

  await runtime.onManualExtract({ drainAll: false, showStartToast: false });
  runtime.refreshPanelLiveState();
  return {
    ...rollbackResult,
    extractionTriggered: true,
    extractionStatus: runtime.getLastExtractionStatusLevel?.() || "idle",
  };
}
