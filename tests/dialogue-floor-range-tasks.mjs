import assert from "node:assert/strict";

import {
  buildDialogueFloorMap,
  normalizeDialogueFloorRange,
} from "../maintenance/chat-history.js";
import {
  onExtractionTaskController,
  onManualExtractController,
} from "../maintenance/extraction-controller.js";
import { onRebuildSummaryStateController } from "../ui/ui-actions-controller.js";

const chat = [
  { is_system: true, is_user: false, mes: "greeting" },
  { is_user: true, mes: "user-1" },
  { is_user: false, mes: "assistant-1" },
  { is_system: true, is_user: false, mes: "real-system" },
  {
    is_system: true,
    is_user: false,
    mes: "managed-hidden-assistant",
    extra: { __st_bme_hide_managed: true },
  },
  { is_user: true, mes: "user-2" },
  { is_user: false, mes: "assistant-2" },
];

{
  const mapping = buildDialogueFloorMap(chat);
  assert.equal(mapping.latestDialogueFloor, 5);
  assert.deepEqual(Array.from(mapping.floorToChatIndex), [0, 1, 2, 4, 5, 6]);
  assert.equal(mapping.floorToRole[0], "greeting");
  assert.deepEqual(Array.from(mapping.assistantDialogueFloors), [2, 3, 5]);
  assert.deepEqual(Array.from(mapping.assistantChatIndices), [2, 4, 6]);
}

{
  const normalized = normalizeDialogueFloorRange(chat, 2, null);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.startFloor, 2);
  assert.equal(normalized.endFloor, 5);
}

{
  const normalized = normalizeDialogueFloorRange(chat, null, 4);
  assert.equal(normalized.valid, false);
  assert.equal(normalized.reason, "end-without-start");
}

{
  const calls = {
    rollback: [],
    manual: [],
    warning: [],
    info: [],
    extractionStatus: [],
  };
  const runtime = {
    getContext() {
      return { chat };
    },
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    setRuntimeStatus() {},
    setLastExtractionStatus(text, meta, level) {
      calls.extractionStatus.push({ text, meta, level });
    },
    rollbackGraphForReroll: async (fromFloor) => {
      calls.rollback.push(fromFloor);
      return { success: true, effectiveFromFloor: fromFloor };
    },
    onManualExtract: async (options = {}) => {
      calls.manual.push({ ...options });
    },
    toastr: {
      warning(message) {
        calls.warning.push(String(message || ""));
      },
      info(message) {
        calls.info.push(String(message || ""));
      },
    },
  };

  const result = await onExtractionTaskController(runtime, {
    mode: "rerun",
    startFloor: 2,
    endFloor: 2,
  });

  assert.equal(result.success, true);
  assert.equal(result.fallbackToLatest, true);
  assert.deepEqual(calls.rollback, [2]);
  assert.equal(calls.manual.length, 1);
  assert.equal(calls.manual[0].lockedEndFloor, null);
  assert.equal(calls.manual[0].taskLabel, "Trích xuất lại");
  assert.equal(calls.manual[0].showStartToast, false);
  assert.equal(calls.extractionStatus[0]?.text, "Trích xuất lạiđang chuẩn bị");
  assert.match(calls.extractionStatus[0]?.meta || "", /thoái hóa thành trích xuất lại từ 2 tới mới nhất/);
  assert.equal(calls.extractionStatus[1]?.text, "Đang trích xuất lại");
  assert.match(calls.extractionStatus[1]?.meta || "", /đangbắt đầuTrích xuất lại/);
  assert.match(result.reason, /thoái hóa thành trích xuất lại từ tầng bắt đầu tới mới nhất/);
}

{
  const calls = {
    rollback: [],
    manual: [],
    extractionStatus: [],
  };
  const runtime = {
    getContext() {
      return { chat };
    },
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    setRuntimeStatus() {},
    setLastExtractionStatus(text, meta, level) {
      calls.extractionStatus.push({ text, meta, level });
    },
    rollbackGraphForReroll: async (fromFloor) => {
      calls.rollback.push(fromFloor);
      return { success: true, effectiveFromFloor: fromFloor };
    },
    onManualExtract: async (options = {}) => {
      calls.manual.push({ ...options });
    },
    toastr: {
      warning() {},
      info() {},
    },
  };

  const result = await onExtractionTaskController(runtime, {
    mode: "rerun",
  });

  assert.equal(result.success, true);
  assert.equal(result.fallbackToLatest, false);
  assert.deepEqual(calls.rollback, [6]);
  assert.equal(calls.manual[0].lockedEndFloor, 6);
  assert.equal(calls.manual[0].showStartToast, false);
  assert.equal(calls.extractionStatus[0]?.text, "Trích xuất lạiđang chuẩn bị");
}

{
  const statuses = [];
  let lastProcessedAssistantFloor = -1;
  const runtime = {
    getIsExtracting() {
      return false;
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    getCurrentGraph() {
      return { historyState: {} };
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      return [2, 6];
    },
    getLastProcessedAssistantFloor() {
      return lastProcessedAssistantFloor;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    clampInt(value, fallback, min, max) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(numeric)));
    },
    setIsExtracting() {},
    beginStageAbortController() {
      return { signal: null };
    },
    finishStageAbortController() {},
    setLastExtractionStatus(text, meta, level) {
      statuses.push({ text, meta, level });
    },
    async executeExtractionBatch({ endIdx }) {
      lastProcessedAssistantFloor = endIdx;
      return {
        success: true,
        result: {
          newNodes: 1,
          updatedNodes: 0,
          newEdges: 1,
        },
        effects: {
          warnings: [],
        },
        historyAdvanceAllowed: true,
      };
    },
    isAbortError() {
      return false;
    },
    refreshPanelLiveState() {},
    retryPendingGraphPersist: async () => ({ accepted: true }),
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
  };

  await onManualExtractController(runtime, {
    taskLabel: "Trích xuất lại",
    toastTitle: "ST-BME Trích xuất lại",
    showStartToast: false,
  });

  assert.equal(statuses[0]?.text, "Đang trích xuất lại");
  assert.match(statuses[0]?.meta || "", /còn 2 phản hồi AI chờ xử lý/);
  assert.ok(
    statuses.some(
      (entry) =>
        entry.text === "Đang trích xuất lại" &&
        /đã xử lý 1\/2 phản hồi AI/.test(entry.meta || ""),
    ),
  );
  assert.equal(statuses[statuses.length - 1]?.text, "Trích xuất lạiHoàn tất");
}

{
  const captured = [];
  const runtime = {
    getCurrentGraph() {
      return {};
    },
    ensureGraphMutationReady() {
      return true;
    },
    getContext() {
      return { chat };
    },
    getSettings() {
      return {};
    },
    rebuildHierarchicalSummaryState: async (payload) => {
      captured.push(payload);
      return { rebuilt: false, reason: "noop" };
    },
    saveGraphToChat() {},
    refreshPanelLiveState() {},
    setRuntimeStatus() {},
    toastr: {
      info() {},
      success() {},
    },
  };

  await onRebuildSummaryStateController(runtime, {});
  await onRebuildSummaryStateController(runtime, { startFloor: 1, endFloor: 3 });

  assert.equal(captured[0].mode, "current");
  assert.equal(captured[0].startFloor, null);
  assert.equal(captured[1].mode, "range");
  assert.equal(captured[1].startFloor, 1);
  assert.equal(captured[1].endFloor, 3);
}

console.log("dialogue-floor-range-tasks tests passed");



