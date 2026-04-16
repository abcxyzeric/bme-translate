import { debugLog } from "../runtime/debug-logging.js";

const MENU_ENTRY_RETRY_MS = 400;
const MENU_ENTRY_MAX_ATTEMPTS = 30;

function resolvePanelTheme(settings) {
  return settings?.panelTheme || "crimson";
}

export function createNoticePanelActionController(runtime) {
  if (!runtime.getPanelModule()?.openPanel) return undefined;
  return {
    label: "Mở bảng",
    kind: "neutral",
    onClick: () => {
      runtime.getPanelModule()?.openPanel?.();
    },
  };
}

export function refreshPanelLiveStateController(runtime) {
  runtime.getPanelModule()?.refreshLiveState?.();
}

export function openPanelController(runtime) {
  runtime.getPanelModule()?.openPanel?.();
}

function injectOptionsMenuEntry(runtime) {
  const doc = runtime.document;
  if (!doc || doc.getElementById("option_st_bme_panel")) {
    return true;
  }
  const menuItem = doc.createElement("a");
  menuItem.id = "option_st_bme_panel";
  menuItem.innerHTML =
    '<i class="fa-lg fa-solid fa-brain"></i><span>Đồ thị ký ức</span>';
  menuItem.addEventListener("click", async () => {
    try {
      await ensurePanelBridgeReady(runtime);
      openPanelController(runtime);
      runtime.$?.("#options")?.hide?.();
    } catch (error) {
      runtime.console.error("[ST-BME] Mở bảng từ menu thất bại:", error);
      globalThis.toastr?.error?.(
        "Tải bảng đồ thị ký ức thất bại, vui lòng xem lỗi trong console",
        "ST-BME",
      );
    }
  });

  const anchor = doc.getElementById("option_toggle_logprobs");
  const optionsContent = doc.querySelector("#options .options-content");

  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(menuItem, anchor.nextSibling);
    return true;
  }
  if (optionsContent) {
    optionsContent.appendChild(menuItem);
    return true;
  }
  return false;
}

function injectFloatingBootstrap(runtime) {
  const doc = runtime.document;
  if (!doc) return false;
  let fab = doc.getElementById("bme-floating-ball");
  if (!fab) {
    fab = doc.createElement("div");
    fab.id = "bme-floating-ball";
    fab.setAttribute("data-status", "idle");
    fab.setAttribute("data-bme-bootstrap", "true");
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME Đồ thị ký ức</span>
    `;
    const mountTarget = doc.body || doc.documentElement;
    if (!mountTarget) return false;
    mountTarget.appendChild(fab);
  }
  if (fab.dataset.bmeBridgeBound === "true") {
    return true;
  }
  fab.dataset.bmeBridgeBound = "true";
  fab.addEventListener("click", async () => {
    try {
      await ensurePanelBridgeReady(runtime);
      openPanelController(runtime);
    } catch (error) {
      runtime.console.error("[ST-BME] Mở bảng từ nút nổi thất bại:", error);
      globalThis.toastr?.error?.(
        "Tải bảng đồ thị ký ức thất bại, vui lòng xem lỗi trong console",
        "ST-BME",
      );
    }
  });
  return true;
}

function scheduleOptionsMenuInjection(runtime, attempt = 0) {
  try {
    injectFloatingBootstrap(runtime);
  } catch (error) {
    runtime.console.warn("[ST-BME] Gắn nút nổi khởi động thất bại:", error);
  }

  try {
    if (injectOptionsMenuEntry(runtime)) {
      return;
    }
  } catch (error) {
    runtime.console.warn("[ST-BME] Gắn lối vào menu thất bại, sẽ thử lại:", error);
  }

  if (attempt >= MENU_ENTRY_MAX_ATTEMPTS) {
    runtime.console.warn(
      "[ST-BME] Gắn lối vào menu bảng điều khiển thất bại: DOM options của host vẫn chưa sẵn sàng",
    );
    return;
  }

  globalThis.setTimeout(() => {
    scheduleOptionsMenuInjection(runtime, attempt + 1);
  }, MENU_ENTRY_RETRY_MS);
}

async function ensurePanelBridgeReady(runtime) {
  const hasPanelDom = Boolean(
    runtime.document.getElementById("st-bme-panel-overlay") &&
      runtime.document.getElementById("st-bme-panel"),
  );
  if (runtime.getPanelModule()?.openPanel && hasPanelDom) {
    return runtime.getPanelModule();
  }

  const panelModule = await runtime.importPanelModule();
  const themesModule = await runtime.importThemesModule();
  runtime.setPanelModule(panelModule);
  runtime.setThemesModule(themesModule);

  const settings = runtime.getSettings();
  const theme = resolvePanelTheme(settings);
  themesModule.applyTheme(theme);

  await panelModule.initPanel({
    getGraph: runtime.getGraph,
    getSettings: runtime.getSettings,
    getLastExtract: runtime.getLastExtract,
    getLastRecall: runtime.getLastRecall,
    getRuntimeStatus: runtime.getRuntimeStatus,
    getLastExtractionStatus: runtime.getLastExtractionStatus,
    getLastVectorStatus: runtime.getLastVectorStatus,
    getLastRecallStatus: runtime.getLastRecallStatus,
    getLastBatchStatus: runtime.getLastBatchStatus,
    getLastInjection: runtime.getLastInjection,
    getRuntimeDebugSnapshot: runtime.getRuntimeDebugSnapshot,
    getGraphPersistenceState: runtime.getGraphPersistenceState,
    updateSettings: (patch) => {
      const nextSettings = runtime.updateSettings(patch);
      if (Object.prototype.hasOwnProperty.call(patch || {}, "panelTheme")) {
        const nextTheme = resolvePanelTheme(nextSettings);
        runtime.getThemesModule()?.applyTheme?.(nextTheme);
        runtime.getPanelModule()?.updatePanelTheme?.(nextTheme);
      }
      return nextSettings;
    },
    actions: runtime.actions,
  });

  return panelModule;
}

export async function initializePanelBridgeController(runtime) {
  try {
    scheduleOptionsMenuInjection(runtime);
    await ensurePanelBridgeReady(runtime);
    debugLog("[ST-BME] Khởi tạo bảng điều khiển hoàn tất");
  } catch (panelError) {
    runtime.console.error(
      "[ST-BME] Tải bảng điều khiển thất bại (chức năng lõi không bị ảnh hưởng):",
      panelError,
    );
    globalThis.toastr?.error?.(
      "Tiền tải bảng đồ thị ký ức thất bại, bạn có thể thử bấm menu lại sau",
      "ST-BME",
    );
  }
}
