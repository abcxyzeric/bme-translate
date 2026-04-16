function getTimerApi(runtime = {}) {
  const rawSetTimeout =
    typeof runtime.setTimeout === "function"
      ? runtime.setTimeout
      : globalThis.setTimeout;
  const rawClearTimeout =
    typeof runtime.clearTimeout === "function"
      ? runtime.clearTimeout
      : globalThis.clearTimeout;

  return {
    setTimeout(...args) {
      return Reflect.apply(rawSetTimeout, globalThis, args);
    },
    clearTimeout(...args) {
      return Reflect.apply(rawClearTimeout, globalThis, args);
    },
  };
}

function hasCompressionMutation(result = {}) {
  return (
    Math.max(0, Number(result?.created) || 0) > 0 ||
    Math.max(0, Number(result?.archived) || 0) > 0
  );
}

function hasSleepMutation(result = {}) {
  return Math.max(0, Number(result?.forgotten) || 0) > 0;
}

function hasConsolidationMutation(result = {}) {
  return (
    Math.max(0, Number(result?.merged) || 0) > 0 ||
    Math.max(0, Number(result?.skipped) || 0) > 0 ||
    Math.max(0, Number(result?.evolved) || 0) > 0 ||
    Math.max(0, Number(result?.connections) || 0) > 0 ||
    Math.max(0, Number(result?.updates) || 0) > 0
  );
}

function findGraphNode(graph, nodeId) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  return graph.nodes.find((node) => node?.id === nodeId) || null;
}

function isManualEvolutionCandidateNode(node) {
  if (!node || node.archived) return false;
  if (Number(node.level || 0) > 0) return false;
  return !["synopsis", "reflection"].includes(String(node.type || ""));
}

function normalizeManualEvolutionCandidateIds(graph, nodeIds = []) {
  const unique = new Set();
  for (const rawId of Array.isArray(nodeIds) ? nodeIds : []) {
    const nodeId = String(rawId || "").trim();
    if (!nodeId || unique.has(nodeId)) continue;
    const node = findGraphNode(graph, nodeId);
    if (!isManualEvolutionCandidateNode(node)) continue;
    unique.add(nodeId);
  }
  return [...unique];
}

function resolveManualEvolutionCandidates(runtime, graph) {
  const liveRecentIds = normalizeManualEvolutionCandidateIds(
    graph,
    runtime.getLastExtractedItems?.()
      ?.map((item) => item?.id)
      .filter(Boolean) || [],
  );
  if (liveRecentIds.length > 0) {
    return {
      ids: liveRecentIds,
      source: "recent-extract",
    };
  }

  const currentExtractionCount = Math.max(
    0,
    Number(graph?.historyState?.extractionCount) || 0,
  );
  const batchJournal = Array.isArray(graph?.batchJournal) ? graph.batchJournal : [];
  for (let index = batchJournal.length - 1; index >= 0; index -= 1) {
    const entry = batchJournal[index];
    const beforeExtractionCount = Math.max(
      0,
      Number(entry?.stateBefore?.extractionCount) || 0,
    );
    if (beforeExtractionCount >= currentExtractionCount) {
      continue;
    }
    const fallbackIds = normalizeManualEvolutionCandidateIds(
      graph,
      entry?.createdNodeIds || [],
    );
    if (fallbackIds.length > 0) {
      return {
        ids: fallbackIds,
        source: "latest-extraction-batch",
      };
    }
  }

  return {
    ids: [],
    source: "none",
  };
}

function describeManualEvolutionSource(source, count) {
  switch (String(source || "")) {
    case "recent-extract":
      return `Sử dụng ${count} nút từ lần trích xuất gần nhất`;
    case "latest-extraction-batch":
      return `Sử dụng ${count} nút từ lô trích xuất được ghi xuống gần nhất`;
    default:
      return `${count} nút ứng viên`;
  }
}

function updateManualActionUiState(runtime, text, meta = "", level = "idle") {
  if (typeof runtime?.setRuntimeStatus === "function") {
    runtime.setRuntimeStatus(text, meta, level);
  }
  runtime?.refreshPanelLiveState?.();
}

function rebindImportedGraphToCurrentChat(runtime, importedGraph) {
  if (!importedGraph || typeof importedGraph !== "object") {
    return {
      rebound: false,
      reason: "missing-graph",
    };
  }

  const chat = runtime.getContext?.()?.chat;
  const assistantTurns =
    typeof runtime.getAssistantTurns === "function" && Array.isArray(chat)
      ? runtime.getAssistantTurns(chat)
      : [];

  if (typeof runtime.rebindProcessedHistoryStateToChat === "function") {
    return runtime.rebindProcessedHistoryStateToChat(
      importedGraph,
      chat,
      assistantTurns,
    );
  }

  importedGraph.historyState.processedMessageHashesNeedRefresh = true;
  return {
    rebound: false,
    reason: "missing-history-rebind-helper",
  };
}

export async function onViewGraphController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) {
    runtime.toastr.warning("Hiện chưa có đồ thị được tải");
    return;
  }

  const stats = runtime.getGraphStats(graph);
  const statsText = [
    `Nút: ${stats.activeNodes} Hoạt động / ${stats.archivedNodes} Lưu trữ`,
    `Cạnh: ${stats.totalEdges}`,
    `Tầng xử lý cuối: ${stats.lastProcessedSeq}`,
    `Phân bố loại: ${
      Object.entries(stats.typeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(空)"
    }`,
  ].join("\n");

  runtime.toastr.info(statsText, "Trạng thái đồ thị ST-BME", { timeOut: 10000 });
}

export async function onTestEmbeddingController(runtime) {
  const config = runtime.getEmbeddingConfig();
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return;
  }

  runtime.toastr.info("Đang kiểm tra kết nối Embedding API...");
  const result = await runtime.testVectorConnection(config, runtime.getCurrentChatId());

  if (result.success) {
    runtime.toastr.success(`Kết nối thành công! Số chiều vector: ${result.dimensions}`);
  } else {
    runtime.toastr.error(`Kết nối thất bại: ${result.error}`);
  }
}

export async function onTestMemoryLLMController(runtime) {
  runtime.toastr.info("Đang kiểm tra kết nối LLM bộ nhớ...");
  const result = await runtime.testLLMConnection();

  if (result.success) {
    runtime.toastr.success(`Kết nối thành công! Chế độ: ${result.mode}`);
  } else {
    runtime.toastr.error(`Kết nối thất bại: ${result.error}`);
  }
}

export async function onFetchMemoryLLMModelsController(runtime) {
  runtime.toastr.info("Đang lấy danh sách model LLM bộ nhớ...");
  const result = await runtime.fetchMemoryLLMModels();

  if (result.success) {
    runtime.toastr.success(`已拉取 ${result.models.length}  model LLM bộ nhớ`);
  } else {
    runtime.toastr.error(`拉取Thất bại: ${result.error}`);
  }

  return result;
}

export async function onFetchEmbeddingModelsController(runtime, mode = null) {
  const config = runtime.getEmbeddingConfig(mode);
  const targetMode = mode || config?.mode || "direct";
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return { success: false, models: [], error: validation.error };
  }

  runtime.toastr.info("Đang lấy danh sách model Embedding...");
  const result = await runtime.fetchAvailableEmbeddingModels(config);

  if (result.success) {
    const modeLabel = targetMode === "backend" ? "Backend" : "直连";
    runtime.toastr.success(
      `已拉取 ${result.models.length}  model Embedding ${modeLabel}`,
    );
  } else {
    runtime.toastr.error(`拉取Thất bại: ${result.error}`);
  }

  return result;
}

export async function onManualCompressController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Nén thủ công")) return;
  updateManualActionUiState(runtime, "Nén thủ côngTrung bình", "Đang kiểm tra nhóm ứng viên có thể nén", "running");

  try {
    const schema = runtime.getSchema();
    const inspection = runtime.inspectCompressionCandidates?.(graph, schema, true);
    if (inspection && !inspection.hasCandidates) {
      const reason = String(
        inspection.reason || "Hiện không có nhóm ứng viên nào có thể nén, lượt này không gửi yêu cầu nén LLM",
      );
      updateManualActionUiState(runtime, "Nén thủ công chưa thực hiện", reason, "idle");
      runtime.toastr.info(reason);
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason,
      };
    }

    updateManualActionUiState(runtime, "Nén thủ côngTrung bình", "Đang gửi yêu cầu LLM nén nhóm ứng viên", "running");
    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const result = await runtime.compressAll(
      graph,
      schema,
      runtime.getEmbeddingConfig(),
      true,
      undefined,
      undefined,
      runtime.getSettings(),
    );
    const mutated = hasCompressionMutation(result);
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "compress",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("compress", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["compression"],
      });
      updateManualActionUiState(
        runtime,
        "Nén thủ công hoàn tất",
        `Tạo mới ${result.created}，Lưu trữ ${result.archived}`,
        "success",
      );
      runtime.toastr.success(
        `Nén thủ công hoàn tất：Tạo mới ${result.created}，Lưu trữ ${result.archived}`,
      );
    } else {
      updateManualActionUiState(
        runtime,
        "Nén thủ công không thay đổi",
        "Đã thử nén, nhưng lượt này không tạo ra thay đổi có thể lưu bền",
        "idle",
      );
      runtime.toastr.info("Đã thử nén thủ công, nhưng lượt này không tạo ra thay đổi có thể lưu bền");
    }

    return {
      handledToast: true,
      requestDispatched: true,
      mutated,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Nén thủ công thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onExportGraphController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;

  const json = runtime.exportGraph(graph);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = runtime.document.createElement("a");
  a.href = url;
  a.download = `st-bme-graph-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  runtime.toastr.success("Đồ thị đã được xuất");
}

export async function onViewLastInjectionController(runtime) {
  const content = runtime.getLastInjectionContent();
  if (!content) {
    runtime.toastr.info("Tạm thời chưa có nội dung tiêm");
    return;
  }

  const popup = runtime.document.createElement("div");
  popup.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#eee;padding:24px;border-radius:12px;max-width:80vw;max-height:80vh;overflow:auto;z-index:99999;white-space:pre-wrap;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.5);";
  popup.textContent = content;

  const close = runtime.document.createElement("button");
  close.textContent = "Tắt";
  close.style.cssText =
    "position:absolute;top:8px;right:12px;background:#e94560;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;";
  close.onclick = () => popup.remove();
  popup.appendChild(close);

  runtime.document.body.appendChild(popup);
}

export async function onRebuildController(runtime) {
  if (!runtime.confirm("Bạn có chắc muốn xây lại đồ thị từ chat hiện tại không? Thao tác này sẽ xóa dữ liệu đồ thị hiện có.")) {
    return;
  }
  if (!runtime.ensureGraphMutationReady("Xây lại đồ thị")) return;

  const context = runtime.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) {
    runtime.toastr.warning("Ngữ cảnh chat hiện tại không khả dụng, không thể xây lại");
    return;
  }

  const previousGraphSnapshot = runtime.getCurrentGraph()
    ? runtime.cloneGraphSnapshot(runtime.getCurrentGraph())
    : runtime.cloneGraphSnapshot(
        runtime.normalizeGraphRuntimeState(
          runtime.createEmptyGraph(),
          runtime.getCurrentChatId(),
        ),
      );
  const previousUiState = runtime.snapshotRuntimeUiState();
  const settings = runtime.getSettings();
  runtime.setRuntimeStatus(
    "Đang xây lại đồ thị",
    `Chat hiện tại ${Array.isArray(chat) ? chat.length : 0}  tin nhắn`,
    "running",
  );

  const nextGraph = runtime.normalizeGraphRuntimeState(
    runtime.createEmptyGraph(),
    runtime.getCurrentChatId(),
  );
  nextGraph.batchJournal = [];
  runtime.setCurrentGraph(nextGraph);
  runtime.clearInjectionState();

  try {
    await runtime.prepareVectorStateForReplay(true);
    const replayedBatches = await runtime.replayExtractionFromHistory(chat, settings);
    runtime.clearHistoryDirty(
      runtime.getCurrentGraph(),
      runtime.buildRecoveryResult("full-rebuild", {
        fromFloor: 0,
        batches: replayedBatches,
        path: "full-rebuild",
        detectionSource: "manual-rebuild",
        affectedBatchCount: runtime.getCurrentGraph().batchJournal?.length || 0,
        replayedBatchCount: replayedBatches,
        reason: "Người dùng tự kích hoạt xây lại toàn lượng",
      }),
    );
    const recoveredLastProcessedFloor = Number.isFinite(
      runtime.getCurrentGraph()?.historyState?.lastProcessedAssistantFloor,
    )
      ? runtime.getCurrentGraph().historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      if (typeof runtime.updateProcessedHistorySnapshot === "function") {
        runtime.updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
      } else if (typeof runtime.applyProcessedHistorySnapshotToGraph === "function") {
        runtime.applyProcessedHistorySnapshotToGraph(
          runtime.getCurrentGraph(),
          chat,
          recoveredLastProcessedFloor,
        );
      }
    }
    runtime.saveGraphToChat({ reason: "manual-rebuild-complete" });
    runtime.setLastExtractionStatus(
      "Xây lại đồ thị hoàn tất",
      `Đã phát lại ${replayedBatches} lô trích xuất`,
      "success",
      {
        syncRuntime: false,
      },
    );

    if (runtime.getCurrentGraph().vectorIndexState?.lastWarning) {
      runtime.setRuntimeStatus(
        "Xây lại đồ thị hoàn tất",
        `Đã phát lại ${replayedBatches} 批，但Vector仍待修复`,
        "warning",
      );
      runtime.toastr.warning(
        `Đồ thị đã được xây lại, nhưng chỉ mục vector vẫn cần sửa: ${runtime.getCurrentGraph().vectorIndexState.lastWarning}`,
      );
    } else {
      runtime.setRuntimeStatus(
        "Xây lại đồ thị hoàn tất",
        `Đã phát lại ${replayedBatches} 批，đồ thị与Vector索引已刷新`,
        "success",
      );
      runtime.toastr.success("Đồ thị và chỉ mục vector đã được xây lại toàn lượng theo chat hiện tại");
    }
  } catch (error) {
    runtime.setCurrentGraph(
      runtime.normalizeGraphRuntimeState(
        previousGraphSnapshot,
        runtime.getCurrentChatId(),
      ),
    );
    runtime.restoreRuntimeUiState(previousUiState);
    runtime.saveGraphToChat({ reason: "manual-rebuild-restore-previous" });
    runtime.setLastExtractionStatus("Xây lại đồ thị thất bại", error?.message || String(error), "error", {
      syncRuntime: true,
    });
    throw new Error(
      `Xây lại đồ thị thất bại, đã khôi phục về trạng thái trước khi xây lại: ${error?.message || error}`,
    );
  } finally {
    runtime.refreshPanelLiveState();
  }
}

export async function onImportGraphController(runtime) {
  if (!runtime.ensureGraphMutationReady("Nhập đồ thị")) {
    return { cancelled: true };
  }

  const input = runtime.document.createElement("input");
  input.type = "file";
  input.accept = ".json";

  return await new Promise((resolve, reject) => {
    const timers = getTimerApi(runtime);
    let settled = false;
    let focusTimer = null;

    const cleanup = () => {
      if (focusTimer) {
        timers.clearTimeout(focusTimer);
        focusTimer = null;
      }
      input.onchange = null;
      runtime.window.removeEventListener("focus", onWindowFocus, true);
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const onWindowFocus = () => {
      focusTimer = timers.setTimeout(() => {
        if (!settled) {
          finish({ cancelled: true });
        }
      }, 180);
    };

    runtime.window.addEventListener("focus", onWindowFocus, true);
    input.addEventListener(
      "cancel",
      () => {
        finish({ cancelled: true });
      },
      { once: true },
    );

    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        finish({ cancelled: true });
        return;
      }

      try {
        const text = await file.text();
        const importedGraph = runtime.normalizeGraphRuntimeState(
          runtime.importGraph(text),
          runtime.getCurrentChatId(),
        );
        const historyRebind = rebindImportedGraphToCurrentChat(
          runtime,
          importedGraph,
        );
        runtime.setCurrentGraph(importedGraph);
        runtime.markVectorStateDirty("Sau khi nhập đồ thị cần xây lại chỉ mục vector");
        runtime.setExtractionCount(
          Math.max(0, Number(importedGraph?.historyState?.extractionCount) || 0),
        );
        runtime.setLastExtractedItems([]);
        runtime.updateLastRecalledItems(importedGraph.lastRecallResult || []);
        runtime.clearInjectionState();
        runtime.saveGraphToChat({ reason: "graph-import-complete" });
        runtime.toastr.success(
          historyRebind?.rebound === true
            ? "Đồ thị đã được nhập và gắn lại với lịch sử chat hiện tại"
            : "Đồ thị đã được nhập",
        );
        finish({ imported: true, handledToast: true });
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error(String(err || "Nhập thất bại"));
        runtime.toastr.error(`Nhập thất bại: ${error.message}`);
        error._stBmeToastHandled = true;
        finish(error, true);
      }
    };

    input.click();
  });
}

export async function onRebuildVectorIndexController(runtime, range = null) {
  if (!runtime.ensureGraphMutationReady(range ? "Xây lại vector theo phạm vi" : "Xây lại vector")) return;
  runtime.ensureCurrentGraphRuntimeState();

  const config = runtime.getEmbeddingConfig();
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return;
  }

  const vectorController = runtime.beginStageAbortController("vector");
  try {
    const result = await runtime.syncVectorState({
      force: true,
      purge: runtime.isBackendVectorConfig(config) && !range,
      range,
      signal: vectorController.signal,
    });

    runtime.saveGraphToChat({ reason: "vector-rebuild-complete" });
    if (result?.aborted) {
      return;
    }
    if (result?.error) {
      throw new Error(result.error);
    }
    runtime.toastr.success(
      range
        ? `Xây lại vector theo phạm vi hoàn tất: indexed=${result.stats.indexed}, pending=${result.stats.pending}`
        : `Xây lại vector của chat hiện tại hoàn tất: indexed=${result.stats.indexed}, pending=${result.stats.pending}`,
    );
  } finally {
    runtime.finishStageAbortController("vector", vectorController);
    runtime.refreshPanelLiveState();
  }
}

export async function onReembedDirectController(runtime) {
  const config = runtime.getEmbeddingConfig();
  if (!runtime.isDirectVectorConfig(config)) {
    runtime.toastr.info("Hiện không ở chế độ kết nối trực tiếp, không cần nhúng lại");
    return;
  }

  await runtime.onRebuildVectorIndex();
}

export async function onManualSleepController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Thực hiện lãng quên")) return;
  updateManualActionUiState(runtime, "Thực hiện lãng quênTrung bình", "Đang đánh giá các nút có thể lưu trữ", "running");

  try {
    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const result = runtime.sleepCycle(graph, runtime.getSettings());
    const mutated = hasSleepMutation(result);
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "sleep",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("sleep", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["sleep"],
      });
      updateManualActionUiState(
        runtime,
        "Thực hiện lãng quên hoàn tất",
        `Lưu trữ ${result.forgotten}  nút`,
        "success",
      );
      runtime.toastr.success(`Thực hiện lãng quên hoàn tất：Lưu trữ ${result.forgotten}  nút`);
    } else {
      updateManualActionUiState(
        runtime,
        "Thực hiện lãng quên không thay đổi",
        "Hiện không có nút nào đạt điều kiện lãng quên",
        "idle",
      );
      runtime.toastr.info(
        "Hiện không có nút nào đạt điều kiện lãng quên. Thao tác này chỉ dọn đồ thị cục bộ, sẽ không gửi yêu cầu LLM.",
      );
    }
    return {
      handledToast: true,
      requestDispatched: false,
      mutated,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Thực hiện lãng quên thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onManualSynopsisController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Tạo tóm tắt ngắn")) return;
  updateManualActionUiState(runtime, "Tạo tóm tắt ngắnTrung bình", "Đang tạo tóm tắt ngắn mới dựa trên cửa sổ nguyên văn", "running");

  try {
    const chat = runtime.getContext?.()?.chat;
    const result = await runtime.generateSmallSummary({
      graph,
      chat: Array.isArray(chat) ? chat : [],
      settings: runtime.getSettings(),
      currentExtractionCount: Number(graph?.historyState?.extractionCount) || 0,
      currentAssistantFloor: runtime.getCurrentChatSeq(),
      currentRange: null,
      currentNodeIds: [],
      force: true,
    });
    if (!result?.created) {
      updateManualActionUiState(
        runtime,
        "Tóm tắt ngắn chưa được tạo",
        result?.reason || "Hiện chưa có phạm vi mới để tạo tóm tắt ngắn",
        "idle",
      );
      runtime.toastr.info(result?.reason || "Hiện chưa có phạm vi mới để tạo tóm tắt ngắn");
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: result?.reason || "",
      };
    }
    runtime.saveGraphToChat?.({ reason: "manual-small-summary" });
    runtime.refreshPanelLiveState?.();
    updateManualActionUiState(runtime, "Tạo tóm tắt ngắn hoàn tất", "新的Tóm tắt ngắn已加入总结前沿", "success");
    runtime.toastr.success("Tạo tóm tắt ngắn hoàn tất");
    return {
      handledToast: true,
      requestDispatched: true,
      mutated: true,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Tạo tóm tắt ngắn thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onManualSummaryRollupController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Thực hiện gộp tóm tắt")) return;
  updateManualActionUiState(runtime, "Đang gộp tóm tắt", "正在折叠当前Tiền tuyến tóm tắt hoạt động", "running");

  try {
    const result = await runtime.rollupSummaryFrontier({
      graph,
      settings: runtime.getSettings(),
      force: true,
    });
    if (!Number(result?.createdCount || 0)) {
      updateManualActionUiState(
        runtime,
        "Gộp tóm tắt未执行",
        result?.reason || "Hiện không có tóm tắt hoạt động nào đạt ngưỡng gộp",
        "idle",
      );
      runtime.toastr.info(result?.reason || "Hiện không có tóm tắt hoạt động nào đạt ngưỡng gộp");
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: result?.reason || "",
      };
    }
    runtime.saveGraphToChat?.({ reason: "manual-summary-rollup" });
    runtime.refreshPanelLiveState?.();
    updateManualActionUiState(
      runtime,
      "Gộp tóm tắt hoàn tất",
      `Đã gộp ${result.foldedCount || 0} mục, số tóm tắt tạo ra ${result.createdCount || 0} 条`,
      "success",
    );
    runtime.toastr.success(
      `Gộp tóm tắt hoàn tất：折叠 ${result.foldedCount || 0} 条，产出 ${result.createdCount || 0} 条`,
    );
    return {
      handledToast: true,
      requestDispatched: true,
      mutated: true,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Gộp tóm tắt thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onRebuildSummaryStateController(runtime, options = {}) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Xây lại trạng thái tóm tắt")) return;
  const hasStart = Number.isFinite(Number(options?.startFloor));
  const hasEnd = Number.isFinite(Number(options?.endFloor));
  const mode = hasStart || hasEnd ? "range" : "current";
  updateManualActionUiState(
    runtime,
    "Đang xây lại tóm tắt",
    mode === "range"
      ? `Đang xây theo phạm vi ${hasStart ? Number(options.startFloor) : "?"} ~ ${hasEnd ? Number(options.endFloor) : "最新"} để xây lại chuỗi tóm tắt`
      : "Đang xây lại phạm vi liên quan đến tóm tắt hiện tại",
    "running",
  );

  try {
    const chat = runtime.getContext?.()?.chat;
    const result = await runtime.rebuildHierarchicalSummaryState({
      graph,
      chat: Array.isArray(chat) ? chat : [],
      settings: runtime.getSettings(),
      mode,
      startFloor: hasStart ? Number(options.startFloor) : null,
      endFloor: hasEnd ? Number(options.endFloor) : null,
    });
    runtime.saveGraphToChat?.({ reason: "rebuild-summary-state" });
    runtime.refreshPanelLiveState?.();
    if (!result?.rebuilt) {
      updateManualActionUiState(
        runtime,
        "Xây lại tóm tắt không tạo thay đổi",
        result?.reason || "Hiện không có chuỗi tóm tắt nào có thể xây lại",
        "idle",
      );
      runtime.toastr.info(result?.reason || "Hiện không có chuỗi tóm tắt nào có thể xây lại");
      return {
        handledToast: true,
        requestDispatched: true,
        mutated: false,
        result,
      };
    }
    updateManualActionUiState(
      runtime,
      "Xây lại tóm tắt hoàn tất",
      `Tóm tắt ngắn ${result.smallSummaryCount || 0} mục, tóm tắt gộp ${result.rollupCount || 0} 条`,
      "success",
    );
    runtime.toastr.success(
      `Xây lại tóm tắt hoàn tất：Tóm tắt ngắn ${result.smallSummaryCount || 0} mục, tóm tắt gộp ${result.rollupCount || 0} 条`,
    );
    return {
      handledToast: true,
      requestDispatched: true,
      mutated: true,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Xây lại tóm tắt thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onClearSummaryStateController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Xóa trạng thái tóm tắt")) return;
  if (
    typeof runtime.confirm === "function" &&
    !runtime.confirm(
      "Bạn có chắc muốn xóa trạng thái tóm tắt của chat hiện tại không?\n\nThao tác này sẽ xóa toàn bộ tiền tuyến tóm tắt phân tầng và lịch sử gộp của chat hiện tại, nhưng sẽ không xóa các nút đồ thị hay nguyên văn chat.",
    )
  ) {
    return {
      cancelled: true,
    };
  }
  runtime.resetHierarchicalSummaryState?.(graph);
  runtime.saveGraphToChat?.({ reason: "clear-summary-state" });
  runtime.refreshPanelLiveState?.();
  updateManualActionUiState(
    runtime,
    "Trạng thái tóm tắt đã được xóa",
    "Tóm tắt phân tầng của chat hiện tại đã được đặt lại",
    "success",
  );
  runtime.toastr.success("Trạng thái tóm tắt của chat hiện tại đã được xóa");
  return {
    handledToast: true,
    requestDispatched: false,
    mutated: true,
  };
}

export async function onManualEvolveController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Tiến hóa cưỡng bức")) return;
  updateManualActionUiState(runtime, "Đang tiến hóa cưỡng bức", "Đang sắp xếp các nút ứng viên", "running");

  try {
    const embeddingConfig = runtime.getEmbeddingConfig();
    const vectorValidation = runtime.validateVectorConfig?.(embeddingConfig);
    if (vectorValidation && !vectorValidation.valid) {
      updateManualActionUiState(
        runtime,
        "Tiến hóa cưỡng bức chưa thực hiện",
        vectorValidation.error,
        "warning",
      );
      runtime.toastr.warning(vectorValidation.error);
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: vectorValidation.error,
      };
    }

    const candidateResolution = resolveManualEvolutionCandidates(runtime, graph);
    const candidateIds = candidateResolution.ids;
    if (candidateIds.length === 0) {
      updateManualActionUiState(
        runtime,
        "Tiến hóa cưỡng bức chưa thực hiện",
        "Hiện không có nút từ lần trích xuất gần nhất nào có thể dùng để tiến hóa",
        "idle",
      );
      runtime.toastr.info("Hiện không có nút từ lần trích xuất gần nhất nào có thể dùng để tiến hóa, lượt này không gửi yêu cầu hợp nhất");
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: "no-candidates",
      };
    }

    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const settings = runtime.getSettings();
    updateManualActionUiState(
      runtime,
      "Đang tiến hóa cưỡng bức",
      `Đang xử lý ${candidateIds.length} nút ứng viên`,
      "running",
    );
    const result = await runtime.consolidateMemories({
      graph,
      newNodeIds: candidateIds,
      embeddingConfig,
      customPrompt: undefined,
      settings,
      options: {
        neighborCount: settings.consolidationNeighborCount,
        conflictThreshold: settings.consolidationThreshold,
      },
    });
    const mutated = hasConsolidationMutation(result);
    const sourceLabel = describeManualEvolutionSource(
      candidateResolution.source,
      candidateIds.length,
    );
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "consolidate",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("consolidate", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["consolidation"],
      });
      updateManualActionUiState(
        runtime,
        "Tiến hóa cưỡng bức hoàn tất",
        `Hợp nhất ${result.merged}, tiến hóa ${result.evolved}, cập nhật ${result.updates}`,
        "success",
      );
      runtime.toastr.success(
        `Tiến hóa cưỡng bức hoàn tất：Hợp nhất ${result.merged}, bỏ qua ${result.skipped}, giữ lại ${result.kept}, tiến hóa ${result.evolved}, liên kết mới ${result.connections}, cập nhật hồi ngược ${result.updates}。${sourceLabel}。`,
      );
    } else {
      updateManualActionUiState(
        runtime,
        "Tiến hóa cưỡng bứcKhông变更",
        `Đã hoàn tất đánh giá hợp nhất, nhưng lượt này không có thay đổi đồ thị.${sourceLabel}。`,
        "idle",
      );
      runtime.toastr.info(
        `Đã hoàn tất đánh giá hợp nhất, nhưng lượt này không tạo ra thay đổi đồ thị.${sourceLabel}。`,
      );
    }

    return {
      handledToast: true,
      requestDispatched: true,
      mutated,
      result,
      candidateSource: candidateResolution.source,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Tiến hóa cưỡng bức thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onUndoLastMaintenanceController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("Hoàn tác lần bảo trì gần nhất")) return;
  updateManualActionUiState(runtime, "Đang hoàn tác lần bảo trì gần nhất", "Đang khôi phục thay đổi bảo trì gần nhất", "running");

  try {
    const result = runtime.undoLastMaintenance?.();
    if (!result?.ok) {
      updateManualActionUiState(
        runtime,
        "Hoàn tác lần bảo trì gần nhất thất bại",
        result?.reason || "Hiện không có bản ghi bảo trì nào có thể hoàn tác",
        "warning",
      );
      runtime.toastr.warning(result?.reason || "Hoàn tác lần bảo trì gần nhất thất bại");
      return { handledToast: true };
    }

    runtime.markVectorStateDirty?.("Sau khi hoàn tác bảo trì cần xây lại chỉ mục vector");
    runtime.saveGraphToChat?.({ reason: "maintenance-undo-complete" });
    updateManualActionUiState(
      runtime,
      "Hoàn tác lần bảo trì gần nhất hoàn tất",
      result.entry?.summary || result.entry?.action || "Đã khôi phục lần bảo trì gần nhất",
      "success",
    );
    runtime.toastr.success(
      `已Đã hoàn tác lần bảo trì gần nhất: ${result.entry?.summary || result.entry?.action || "Thao tác không rõ"}`,
    );
    return {
      handledToast: true,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "Hoàn tác lần bảo trì gần nhất thất bại",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

// ==================== Dọn dữ liệu ====================

export async function onClearGraphController(runtime) {
  if (!runtime.confirm("确定要Xóa đồ thị hiện tại？\n\n所有nút和边将被Xóa，Thao tác不可撤销。")) {
    return { cancelled: true };
  }
  if (!runtime.ensureGraphMutationReady("清空đồ thị")) return;
  const chatId = runtime.getCurrentChatId?.();

  if (chatId && typeof runtime.clearCurrentChatRecoveryAnchors === "function") {
    runtime.clearCurrentChatRecoveryAnchors({
      chatId,
      reason: "manual-clear-graph",
      immediate: true,
      clearMetadataFull: true,
      clearCommitMarker: true,
      clearPendingPersist: true,
    });
  }

  const nextGraph = runtime.normalizeGraphRuntimeState(
    runtime.createEmptyGraph(),
    runtime.getCurrentChatId(),
  );
  runtime.setCurrentGraph(nextGraph);
  runtime.clearInjectionState();
  runtime.markVectorStateDirty?.("清空đồ thị后需要Xây lại vector索引");
  runtime.setExtractionCount(0);
  runtime.setLastExtractedItems([]);
  runtime.saveGraphToChat({
    reason: "manual-clear-graph",
    persistMetadata: true,
    captureShadow: false,
  });
  runtime.refreshPanelLiveState();
  const persistenceState = runtime.getGraphPersistenceState?.() || {};
  const remoteSyncMayRestore =
    Number(persistenceState.lastSyncedRevision || 0) > 0 &&
    String(runtime.getSettings?.()?.cloudStorageMode || "automatic") !== "manual";
  runtime.toastr.success(
    remoteSyncMayRestore
      ? "đồ thị hiện tại已清空；若刷新后旧nút重新出现，请再Xóa dữ liệu đồng bộ máy chủ"
      : "đồ thị hiện tại已清空",
  );
  return { handledToast: true };
}

export async function onClearGraphRangeController(runtime, startSeq, endSeq) {
  if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || startSeq > endSeq) {
    runtime.toastr.warning("请填写有效的起始和Tầng kết thúc");
    return { handledToast: true };
  }
  if (
    !runtime.confirm(
      `确定要Xóatầng ${startSeq} ~ ${endSeq} Phạm vi内的所有nút？\n\nThao tác不可撤销。`,
    )
  ) {
    return { cancelled: true };
  }
  if (!runtime.ensureGraphMutationReady("Dọn theo phạm vi tầng")) return;

  const graph = runtime.getCurrentGraph();
  if (!graph) return;

  const nodesToRemove = graph.nodes.filter((node) => {
    const range = Array.isArray(node.seqRange) ? node.seqRange : [node.seq, node.seq];
    const nodeStart = Number(range[0]) || 0;
    const nodeEnd = Number(range[1]) || 0;
    return nodeEnd >= startSeq && nodeStart <= endSeq;
  });

  let removedCount = 0;
  for (const node of nodesToRemove) {
    if (runtime.removeNode(graph, node.id)) {
      removedCount += 1;
    }
  }

  if (removedCount > 0) {
    runtime.markVectorStateDirty?.("Dọn theo phạm vi tầng后需要Xây lại vector索引");
    runtime.saveGraphToChat({ reason: "manual-clear-graph-range" });
  }
  runtime.refreshPanelLiveState();
  runtime.toastr.success(`已Xóatầng ${startSeq}~${endSeq} Phạm vi内 ${removedCount}  nút`);
  return { handledToast: true };
}

export async function onClearVectorCacheController(runtime) {
  if (!runtime.confirm("确定要Xóa bộ đệm vector？\n\n清空后需要重新构建Vector索引。")) {
    return { cancelled: true };
  }

  const graph = runtime.getCurrentGraph();
  if (!graph) {
    runtime.toastr.warning("Hiện chưa có đồ thị được tải");
    return { handledToast: true };
  }

  if (graph.vectorIndexState) {
    graph.vectorIndexState.hashToNodeId = {};
    graph.vectorIndexState.nodeToHash = {};
    graph.vectorIndexState.dirty = true;
    graph.vectorIndexState.dirtyReason = "manual-clear-vector-cache";
    graph.vectorIndexState.lastWarning = "Vector缓存已Thủ công清空，需要重建索引";
  }

  runtime.saveGraphToChat({ reason: "manual-clear-vector-cache" });
  runtime.refreshPanelLiveState();
  runtime.toastr.success("Vector缓存已清空，请Xây lại vector索引");
  return { handledToast: true };
}

export async function onClearBatchJournalController(runtime) {
  if (!runtime.confirm("确定要Xóa lịch sử trích xuất？\n\nTrích xuất批lần记录和计数将被Đặt lại。")) {
    return { cancelled: true };
  }

  const graph = runtime.getCurrentGraph();
  if (!graph) {
    runtime.toastr.warning("Hiện chưa có đồ thị được tải");
    return { handledToast: true };
  }

  graph.batchJournal = [];
  if (graph.historyState) {
    graph.historyState.extractionCount = 0;
  }
  runtime.setExtractionCount(0);
  runtime.saveGraphToChat({ reason: "manual-clear-batch-journal" });
  runtime.refreshPanelLiveState();
  runtime.toastr.success("Trích xuất历史已清空");
  return { handledToast: true };
}

export async function onDeleteCurrentIdbController(runtime) {
  const chatId = runtime.getCurrentChatId();
  if (!chatId) {
    runtime.toastr.warning("Hiện không có ngữ cảnh chat");
    return { handledToast: true };
  }

  const dbName = runtime.buildBmeDbName(chatId);
  const restoreSafetyDbName = runtime.buildRestoreSafetyDbName?.(chatId) || "";
  const restoreSafetyChatId =
    typeof runtime.buildRestoreSafetyChatId === "function"
      ? runtime.buildRestoreSafetyChatId(chatId)
      : `__restore_safety__${chatId}`;
  const persistenceState = runtime.getGraphPersistenceState?.() || {};
  const hostProfile = String(persistenceState.hostProfile || "generic-st");
  const localStoreLabel =
    hostProfile === "luker"
      ? "Chat hiện tại的Bộ đệm cục bộ（IndexedDB / OPFS，不影响 Lưu trữ chính của sidecar Luker）"
      : "Chat hiện tại的Cục bộđồ thị存储（IndexedDB / OPFS）";
  if (
    !runtime.confirm(
      `确定要Xóa${localStoreLabel}？\n\n将尝试清理：\n- ${dbName}\n- OPFS Chat hiện tại目录\n- restore safety Cục bộbản sao\n\nThao tác不可撤销。`,
    )
  ) {
    return { cancelled: true };
  }

  try {
    await runtime.closeBmeDb?.(chatId);
    let deletedIndexedDbCount = 0;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => {
        deletedIndexedDbCount += 1;
        resolve();
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
    if (restoreSafetyDbName) {
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(restoreSafetyDbName);
        req.onsuccess = () => {
          deletedIndexedDbCount += 1;
          resolve();
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      });
    }
    const currentOpfsResult = await runtime.deleteCurrentChatOpfsStorage?.(chatId);
    const restoreSafetyOpfsResult =
      restoreSafetyChatId && restoreSafetyChatId !== chatId
        ? await runtime.deleteCurrentChatOpfsStorage?.(restoreSafetyChatId)
        : null;
    runtime.clearCachedIndexedDbSnapshot?.(chatId);
    runtime.clearCachedIndexedDbSnapshot?.(restoreSafetyChatId);
    if (typeof runtime.clearCurrentChatRecoveryAnchors === "function") {
      runtime.clearCurrentChatRecoveryAnchors({
        chatId,
        reason: "manual-delete-current-local-storage",
        immediate: true,
        clearMetadataFull: true,
        clearCommitMarker: true,
        clearPendingPersist: true,
      });
      if (restoreSafetyChatId && restoreSafetyChatId !== chatId) {
        runtime.clearCurrentChatRecoveryAnchors({
          chatId: restoreSafetyChatId,
          reason: "manual-delete-current-local-storage:restore-safety",
          immediate: true,
          clearMetadataFull: false,
          clearCommitMarker: false,
          clearPendingPersist: false,
        });
      }
    } else {
      runtime.clearCurrentChatCommitMarker?.({
        reason: "manual-delete-current-local-storage",
        immediate: true,
        resetAcceptedRevision: true,
      });
    }
    await runtime.refreshCurrentChatLocalStoreBinding?.({
      chatId,
      forceCapabilityRefresh: true,
      reopenCurrentDb: true,
      source: "manual-delete-current-local-storage",
    });
    runtime.syncGraphLoadFromLiveContext?.({
      source: "manual-delete-current-local-storage",
      force: true,
    });
    runtime.refreshPanelLiveState?.();
    const deletedOpfs =
      currentOpfsResult?.deleted === true ||
      restoreSafetyOpfsResult?.deleted === true;
    const remoteSyncMayRestore =
      Number(runtime.getGraphPersistenceState?.()?.lastSyncedRevision || 0) > 0 &&
      String(runtime.getSettings?.()?.cloudStorageMode || "automatic") !== "manual";
    runtime.toastr.success(
      `已Xóa lưu trữ cục bộ của chat hiện tại：IndexedDB ${deletedIndexedDbCount > 0 ? "已Xử lý" : "Không"}，OPFS ${deletedOpfs ? "已Xử lý" : "Không"}${remoteSyncMayRestore ? "；若刷新后旧图Khôi phục，请再Xóa服务端Đồng bộDữ liệu" : ""}`,
    );
  } catch (error) {
    runtime.toastr.error(`XóaThất bại: ${error?.message || error}`);
  }
  return { handledToast: true };
}

export async function onDeleteAllIdbController(runtime) {
  const userInput = runtime.prompt(
    "此Thao tác会Xóa所有聊天的 BME Cục bộđồ thị存储（IndexedDB / OPFS），不影响 Lưu trữ chính của sidecar Luker。\n\n请输入 DELETE Xác nhận：",
  );
  if (userInput !== "DELETE") {
    if (userInput != null) {
      runtime.toastr.warning("输入不匹配，Thao tác已Hủy");
    }
    return { cancelled: true };
  }

  try {
    await runtime.closeAllBmeDbs?.();
    const databases = await indexedDB.databases();
    const bmeDbs = databases.filter((db) =>
      String(db.name || "").startsWith("STBME_"),
    );
    if (bmeDbs.length === 0) {
      runtime.toastr.info("没有找到 BME Bộ đệm cục bộDữ liệu库");
      return { handledToast: true };
    }

    let deletedCount = 0;
    for (const db of bmeDbs) {
      try {
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(db.name);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve();
        });
        deletedCount += 1;
      } catch {
        // continue deleting others
      }
    }
    const opfsResult = await runtime.deleteAllOpfsStorage?.();

    runtime.clearAllCachedIndexedDbSnapshots?.();
    const activeChatId = runtime.getCurrentChatId?.();
    if (activeChatId) {
      if (typeof runtime.clearCurrentChatRecoveryAnchors === "function") {
        runtime.clearCurrentChatRecoveryAnchors({
          chatId: activeChatId,
          reason: "manual-delete-all-local-storage",
          immediate: true,
          clearMetadataFull: true,
          clearCommitMarker: true,
          clearPendingPersist: true,
        });
      } else {
        runtime.clearCurrentChatCommitMarker?.({
          reason: "manual-delete-all-local-storage",
          immediate: true,
          resetAcceptedRevision: true,
        });
      }
      await runtime.refreshCurrentChatLocalStoreBinding?.({
        chatId: activeChatId,
        forceCapabilityRefresh: true,
        reopenCurrentDb: true,
        source: "manual-delete-all-local-storage",
      });
      runtime.syncGraphLoadFromLiveContext?.({
        source: "manual-delete-all-local-storage",
        force: true,
      });
    }
    runtime.refreshPanelLiveState?.();
    if (bmeDbs.length === 0 && opfsResult?.deleted !== true) {
      runtime.toastr.info("没有找到 BME Cục bộđồ thị存储");
      return { handledToast: true };
    }
    runtime.toastr.success(
      `已清空 BME Cục bộđồ thị存储：IndexedDB ${deletedCount}/${bmeDbs.length}，OPFS ${opfsResult?.deleted ? "已Xử lý" : "Không"}`,
    );
  } catch (error) {
    runtime.toastr.error(`XóaThất bại: ${error?.message || error}`);
  }
  return { handledToast: true };
}

export async function onDeleteServerSyncFileController(runtime) {
  const chatId = runtime.getCurrentChatId();
  if (!chatId) {
    runtime.toastr.warning("Hiện không có ngữ cảnh chat");
    return { handledToast: true };
  }

  const userInput = runtime.prompt(
    "此Thao tác会XóaChat hiện tại在服务端的Đồng bộDữ liệu。\n\n如果该聊天已经升级到远端 v2，Đồng bộ manifest 和 chunk 文件都会一起Xóa。\n\n请输入 DELETE Xác nhận：",
  );
  if (userInput !== "DELETE") {
    if (userInput != null) {
      runtime.toastr.warning("输入不匹配，Thao tác已Hủy");
    }
    return { cancelled: true };
  }

  try {
    const result = await runtime.deleteRemoteSyncFile(chatId);
    if (result?.deleted) {
      runtime.toastr.success(`已Xóa服务端Đồng bộDữ liệu: ${result.filename}`);
    } else {
      runtime.toastr.info(
        result?.reason === "not-found"
          ? "服务端没有找到Đồng bộDữ liệu"
          : `Xóa未成功: ${result?.reason || "Không rõNguyên nhân"}`,
      );
    }
  } catch (error) {
    runtime.toastr.error(`XóaThất bại: ${error?.message || error}`);
  }
  return { handledToast: true };
}
