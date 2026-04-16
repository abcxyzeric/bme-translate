// ST-BME: Logic tương tác bảng điều khiển

import { GraphRenderer } from "./graph-renderer.js";
import {
  buildVisibleGraphRefreshToken,
  resolveVisibleGraphWorkspaceMode,
} from "./panel-graph-refresh-utils.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import {
  buildRegionLine,
  buildScopeBadgeText,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { listKnowledgeOwners } from "../graph/knowledge-state.js";
import { getHostUserAliasHints } from "../runtime/user-alias-utils.js";
import {
  normalizeStoryTime,
  normalizeStoryTimeSpan,
} from "../graph/story-timeline.js";
import {
  compareSummaryEntriesForDisplay,
  getActiveSummaryEntries,
  getSummaryEntriesByStatus,
} from "../graph/summary-state.js";
import {
  resolveActiveLlmPresetName,
  resolveDedicatedLlmProviderConfig,
  sanitizeLlmPresetSettings,
} from "../llm/llm-preset-utils.js";
import {
  cloneTaskProfile,
  createDefaultGlobalTaskRegex,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createLocalRegexRule,
  DEFAULT_TASK_BLOCKS,
  dedupeRegexRules,
  ensureTaskProfiles,
  exportTaskProfile as serializeTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeOptions,
  importTaskProfile as parseImportedTaskProfile,
  isTaskRegexStageEnabled,
  migrateLegacyProfileRegexToGlobal,
  normalizeGlobalTaskRegex,
  normalizeTaskRegexStages,
  restoreDefaultTaskProfile,
  setActiveTaskProfileId,
  upsertTaskProfile,
} from "../prompting/prompt-profiles.js";
import { getNodeColors } from "./themes.js";
import {
  getSuggestedBackendModel,
  getVectorIndexStats,
} from "../vector/vector-index.js";

let defaultPromptCache = null;

function _refreshMemoryLlmProviderHelp(urlValue = null) {
  const helpEl = document.getElementById("bme-memory-llm-provider-help");
  if (!helpEl) return;

  const settings = _getSettings?.() || {};
  const rawUrl = String(
    urlValue ??
      document.getElementById("bme-setting-llm-url")?.value ??
      settings.llmApiUrl ??
      "",
  ).trim();

  if (!rawUrl) {
    helpEl.textContent =
      "Để trống sẽ dùng lại model chat hiện tại. Hỗ trợ tự động nhận diện kênh OpenAI tương thích, Anthropic Claude, Google AI Studio / Gemini; khi điền endpoint đầy đủ sẽ tự chuẩn hóa thành base URL có thể tái sử dụng.";
    return;
  }

  const resolved = resolveDedicatedLlmProviderConfig(rawUrl);
  const parts = [];

  if (resolved.isKnownProvider) {
    parts.push(`Đã nhận diện kênh：${resolved.providerLabel || resolved.providerId || "Kênh không xác định"}`);
  } else {
    parts.push("Không nhận diện được là kênh cụ thể; sẽ xử lý như giao diện OpenAI tương thích tùy chỉnh");
  }

  if (resolved.transportLabel) {
    parts.push(`Kênh yêu cầu：${resolved.transportLabel}`);
  }

  if (resolved.apiUrl && resolved.apiUrl !== rawUrl) {
    parts.push(`Địa chỉ chuẩn hóa：${resolved.apiUrl}`);
  }

  if (resolved.supportsModelFetch !== true) {
    parts.push("Kênh này hiện chưa hỗ trợ tự động lấy model, vui lòng nhập tên model thủ công");
  }

  helpEl.textContent = parts.join("；");
}

function getDefaultPrompts() {
  if (defaultPromptCache) {
    return defaultPromptCache;
  }

  const prompts = {};
  for (const [key, block] of Object.entries(DEFAULT_TASK_BLOCKS || {})) {
    prompts[key] = [block?.role, block?.format, block?.rules]
      .filter(Boolean)
      .join("\n\n");
  }

  defaultPromptCache = prompts;
  return prompts;
}

function getDefaultPromptText(taskType = "") {
  return getDefaultPrompts()[taskType] || "";
}

const TASK_PROFILE_TABS = [
  { id: "generation", label: "Tham số sinh" },
  { id: "prompt", label: "Dàn prompt" },
  { id: "debug", label: "Xem trước gỡ lỗi" },
];

const TASK_PROFILE_ROLE_OPTIONS = [
  { value: "system", label: "system" },
  { value: "user", label: "user" },
  { value: "assistant", label: "assistant" },
];

const TASK_PROFILE_INJECTION_OPTIONS = [
  { value: "append", label: "Nối thêm" },
  { value: "prepend", label: "Đặt trước" },
  { value: "relative", label: "Tương đối" },
];

const TASK_PROFILE_BOOLEAN_OPTIONS = [
  { value: "", label: "Theo mặc định" },
  { value: "true", label: "Bật" },
  { value: "false", label: "Tắt" },
];

const GRAPH_WRITE_ACTION_IDS = [
  "bme-act-extract",
  "bme-act-compress",
  "bme-act-sleep",
  "bme-act-synopsis",
  "bme-act-summary-rollup",
  "bme-act-summary-rebuild",
  "bme-act-evolve",
  "bme-act-undo-maintenance",
  "bme-act-import",
  "bme-act-rebuild",
  "bme-act-vector-rebuild",
  "bme-act-vector-range",
  "bme-act-vector-reembed",
  "bme-detail-delete",
  "bme-detail-save",
  "bme-cog-region-apply",
  "bme-cog-region-clear",
  "bme-cog-adjacency-save",
  "bme-cog-story-time-apply",
  "bme-cog-story-time-clear",
];

const TASK_PROFILE_GENERATION_GROUPS = [
  {
    title: "Cấu hình API",
    fields: [
      {
        key: "llm_preset",
        label: "Mẫu cấu hình API",
        type: "llm_preset",
        defaultValue: "",
        help: "Để trống nghĩa là đi theo API hiện tại; sau khi chọn mẫu đã lưu, tác vụ này sẽ dùng riêng bộ URL / Key / Model đó.",
      },
    ],
  },
  {
    title: "Tham số sinh cơ bản",
    fields: [
      { key: "max_context_tokens", label: "Token ngữ cảnh tối đa", type: "number", defaultValue: "" },
      { key: "max_completion_tokens", label: "Token hoàn tất tối đa", type: "number", defaultValue: "" },
      { key: "reply_count", label: "Số lượt phản hồi", type: "number", defaultValue: 1 },
      { key: "stream", label: "Xuất luồng", type: "tri_bool", defaultValue: false },
      { key: "temperature", label: "Nhiệt độ (Temperature)", type: "range", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "top_p", label: "Top P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 1 },
      { key: "top_k", label: "Top K", type: "number", defaultValue: 0 },
      { key: "top_a", label: "Top A", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "min_p", label: "Min P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "seed", label: "Hạt giống ngẫu nhiên (Seed)", type: "number", defaultValue: "" },
    ],
  },
  {
    title: "Tham số phạt",
    fields: [
      { key: "frequency_penalty", label: "Phạt tần suất", type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "presence_penalty", label: "Phạt xuất hiện", type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "repetition_penalty", label: "Phạt lặp lại", type: "range", min: 0, max: 3, step: 0.01, defaultValue: 1 },
    ],
  },
  {
    title: "Tham số hành vi",
    fields: [
      { key: "squash_system_messages", label: "Gộp tin nhắn hệ thống", type: "tri_bool", defaultValue: false },
      {
        key: "reasoning_effort",
        label: "Cường độ suy luận",
        type: "enum",
        options: [
          { value: "", label: "Theo mặc định" },
          { value: "minimal", label: "Thấp nhất" },
          { value: "low", label: "Thấp" },
          { value: "medium", label: "Trung bình" },
          { value: "high", label: "Cao" },
        ],
        defaultValue: "",
      },
      { key: "request_thoughts", label: "Yêu cầu quá trình suy nghĩ", type: "tri_bool", defaultValue: false },
      { key: "enable_function_calling", label: "Gọi hàm", type: "tri_bool", defaultValue: false },
      { key: "enable_web_search", label: "Tìm kiếm web", type: "tri_bool", defaultValue: false },
      { key: "character_name_prefix", label: "Tiền tố tên nhân vật", type: "text", defaultValue: "" },
      { key: "wrap_user_messages_in_quotes", label: "Đặt trong ngoặc kép cho tin nhắn người dùng", type: "tri_bool", defaultValue: false },
    ],
  },
];

const TASK_PROFILE_INPUT_GROUPS = {
  synopsis: [
    {
      title: "Đầu vào tóm tắt",
      fields: [
        {
          key: "rawChatContextFloors",
          label: "Tầng ngữ cảnh nguyên văn bổ sung",
          type: "number",
          defaultValue: 0,
          help: "Bổ sung thêm bao nhiêu tầng ngữ cảnh nguyên văn ngoài phạm vi tin nhắn chính; chỉ ảnh hưởng tới tác vụ tóm tắt ngắn.",
        },
        {
          key: "rawChatSourceMode",
          label: "Chế độ nguồn nguyên văn",
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "Bỏ qua ẩn trợ lý của BME" },
          ],
          defaultValue: "ignore_bme_hide",
          help: "Luôn bỏ qua phần cắt ẩn trợ lý của chính BME; chỉ dùng khi đọc nguyên văn cho tóm tắt ngắn.",
        },
      ],
    },
  ],
  summary_rollup: [
    {
      title: "Đầu vào gộp",
      fields: [
        {
          key: "rawChatSourceMode",
          label: "Chế độ nguồn nguyên văn",
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "Bỏ qua ẩn trợ lý của BME (chỉ giữ ô tương thích)" },
          ],
          defaultValue: "ignore_bme_hide",
          help: "Tóm tắt gộp mặc định không đọc trực tiếp nguyên văn chat; phần này giữ lại ô cấu hình để tương thích.",
        },
      ],
    },
  ],
};

const TASK_PROFILE_REGEX_STAGES = [
  {
    key: "input",
    label: "Công tắc tổng đầu vào",
    desc: "Điều khiển toàn bộ các giai đoạn đầu vào; các giai đoạn con không ghi đè riêng sẽ đi theo nó.",
  },
  {
    key: "input.userMessage",
    label: "Đầu vào: tin nhắn người dùng",
    desc: "Xử lý `userMessage` hiện tại.",
  },
  {
    key: "input.recentMessages",
    label: "Đầu vào: ngữ cảnh gần đây",
    desc: "Xử lý `recentMessages`, `chatMessages`, `dialogueText`.",
  },
  {
    key: "input.candidateText",
    label: "Đầu vào: ứng viên và tóm tắt",
    desc: "Xử lý `candidateText`, `candidateNodes`, `nodeContent` và các loại tóm tắt.",
  },
  {
    key: "input.finalPrompt",
    label: "Đầu vào: message cuối trước khi gửi",
    desc: "Làm sạch thống nhất trước khi toàn bộ `messages` được lắp ghép xong và thật sự gửi cho LLM.",
  },
  {
    key: "output",
    label: "Công tắc tổng đầu ra",
    desc: "Điều khiển toàn bộ các giai đoạn đầu ra; các giai đoạn con không ghi đè riêng sẽ đi theo nó.",
  },
  {
    key: "output.rawResponse",
    label: "Đầu ra: phản hồi gốc",
    desc: "Làm sạch một lần ngay sau khi nhận được văn bản gốc từ LLM.",
  },
  {
    key: "output.beforeParse",
    label: "Đầu ra: trước khi phân tích",
    desc: "Làm sạch thêm một lần trước khi trích xuất/phân tích JSON.",
  },
];

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let currentTabId = "dashboard";
let currentConfigSectionId = "toggles";
let currentTaskSectionId = "pipeline";
let currentSelectedMemoryNodeId = "";
let taskMemorySearchDraft = _createTaskMemorySearchState();
let taskMemorySearchApplied = _createTaskMemorySearchState();
let currentTaskProfileTaskType = "extract";
let currentTaskProfileTabId = "generation";
let currentTaskProfileBlockId = "";
let currentTaskProfileDragBlockId = "";
let currentTaskProfileRuleId = "";
let currentTaskProfileDragRuleId = "";
let currentTaskProfileDragRuleIsGlobal = false;
let showGlobalRegexPanel = false;
let currentGlobalRegexRuleId = "";
let currentCognitionOwnerKey = "";
let currentGraphView = "graph";
let currentMobileGraphView = "graph";
let fetchedMemoryLLMModels = [];
let fetchedBackendEmbeddingModels = [];
let fetchedDirectEmbeddingModels = [];
let viewportSyncBound = false;
let popupRuntimePromise = null;
const GRAPH_LIVE_REFRESH_THROTTLE_MS = 240;
let pendingVisibleGraphRefreshTimer = null;
let pendingVisibleGraphRefreshToken = "";
let pendingVisibleGraphRefreshForce = false;
let lastVisibleGraphRefreshToken = "";
let lastVisibleGraphRefreshAt = 0;
let graphRenderingEnabled = true;

// Tham chiếu được `index.js` bơm vào
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastBatchStatus = null;
let _getLastRecall = null;
let _getRuntimeStatus = null;
let _getLastExtractionStatus = null;
let _getLastVectorStatus = null;
let _getLastRecallStatus = null;
let _getLastInjection = null;
let _getRuntimeDebugSnapshot = null;
let _getGraphPersistenceState = null;
let _updateSettings = null;
let _actionHandlers = {};

async function loadLocalTemplate(templateName) {
  const templateUrl = new URL(`./${templateName}.html`, import.meta.url);
  const response = await fetch(templateUrl.href, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Template request failed: ${templateUrl.pathname} (${response.status} ${response.statusText})`,
    );
  }
  const html = await response.text();
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error(`Template returned empty content: ${templateUrl.pathname}`);
  }
  return html;
}

async function getPopupRuntime() {
  if (!popupRuntimePromise) {
    popupRuntimePromise = import("../../../../popup.js");
  }
  return await popupRuntimePromise;
}

function _ensureCloudBackupManagerStyles() {
  if (document.getElementById("bme-cloud-backup-manager-styles")) return;
  const style = document.createElement("style");
  style.id = "bme-cloud-backup-manager-styles";
  style.textContent = `
    .bme-cloud-backup-modal {
      width: min(920px, 88vw);
      max-width: 100%;
      color: var(--SmartThemeBodyColor, #f2efe8);
    }
    .bme-cloud-backup-modal__header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }
    .bme-cloud-backup-modal__title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
    }
    .bme-cloud-backup-modal__subtitle {
      opacity: 0.78;
      line-height: 1.5;
      margin-top: 6px;
    }
    .bme-cloud-backup-modal__tools {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .bme-cloud-backup-modal__btn {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.06));
      color: inherit;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .bme-cloud-backup-modal__btn:hover:not(:disabled) {
      border-color: rgba(255, 181, 71, 0.65);
    }
    .bme-cloud-backup-modal__btn:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .bme-cloud-backup-modal__list {
      display: grid;
      gap: 12px;
      max-height: 62vh;
      overflow: auto;
      padding-right: 4px;
    }
    .bme-cloud-backup-modal__empty,
    .bme-cloud-backup-modal__loading {
      border: 1px dashed var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 18px;
      opacity: 0.85;
      text-align: center;
    }
    .bme-cloud-backup-card {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 14px;
      background: rgba(255,255,255,0.03);
    }
    .bme-cloud-backup-card.is-current-chat {
      border-color: rgba(255, 181, 71, 0.78);
      box-shadow: 0 0 0 1px rgba(255, 181, 71, 0.22) inset;
    }
    .bme-cloud-backup-card__top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .bme-cloud-backup-card__title {
      font-size: 16px;
      font-weight: 700;
      word-break: break-all;
    }
    .bme-cloud-backup-card__badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255, 181, 71, 0.18);
      color: #ffcd73;
      flex-shrink: 0;
    }
    .bme-cloud-backup-card__meta {
      display: grid;
      gap: 4px;
      font-size: 13px;
      opacity: 0.86;
      margin-bottom: 10px;
    }
    .bme-cloud-backup-card__filename {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      opacity: 0.75;
      word-break: break-all;
      margin-bottom: 12px;
    }
    .bme-cloud-backup-card__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bme-cloud-backup-card__danger {
      border-color: rgba(255, 99, 99, 0.45);
    }
    .bme-cloud-backup-card__danger:hover:not(:disabled) {
      border-color: rgba(255, 99, 99, 0.72);
    }
    @media (max-width: 720px) {
      .bme-cloud-backup-modal__header {
        flex-direction: column;
      }
      .bme-cloud-backup-modal__tools {
        justify-content: flex-start;
      }
      .bme-cloud-backup-card__top {
        flex-direction: column;
      }
    }
  `;
  document.head?.appendChild(style);
}

function mountPanelHtml(html) {
  const markup = String(html || "").trim();
  if (!markup) {
    throw new Error("Panel template markup is empty");
  }

  if (document.body?.insertAdjacentHTML) {
    document.body.insertAdjacentHTML("beforeend", markup);
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = markup;
  const fragment = template.content.cloneNode(true);
  document.documentElement?.appendChild(fragment);
}

function ensureNodeMountedAtRoot(node, { beforeBody = false } = {}) {
  if (!node) return;
  const root = document.documentElement;
  const body = document.body;
  if (!root) return;

  if (beforeBody && body?.parentElement === root) {
    if (node.parentElement === root && node.nextElementSibling === body) {
      return;
    }
    root.insertBefore(node, body);
    return;
  }

  if (node.parentElement === root) {
    return;
  }

  root.appendChild(node);
}

function ensureOverlayMountedAtRoot() {
  ensureNodeMountedAtRoot(overlayEl, { beforeBody: true });
}

function ensureFabMountedAtRoot() {
  ensureNodeMountedAtRoot(_fabEl);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: Math.max(
      1,
      Math.round(viewport?.width || window.innerWidth || 0),
    ),
    height: Math.max(
      1,
      Math.round(viewport?.height || window.innerHeight || 0),
    ),
  };
}

function syncViewportCssVars() {
  const rootStyle = document.documentElement?.style;
  if (!rootStyle) return;

  const { width, height } = getViewportMetrics();

  rootStyle.setProperty("--bme-viewport-width", `${width}px`);
  rootStyle.setProperty("--bme-viewport-height", `${height}px`);
}

function getFabFallbackSize() {
  return _isMobile() ? 54 : 46;
}

function getFabSize(fab = _fabEl) {
  if (fab) {
    const rect = fab.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        width: rect.width,
        height: rect.height,
      };
    }
  }

  const fallback = getFabFallbackSize();
  return {
    width: fallback,
    height: fallback,
  };
}

function getDefaultFabPosition(fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const sideGap = _isMobile() ? 14 : 16;
  const bottomGap = _isMobile() ? 96 : 80;

  return {
    x: Math.max(sideGap, viewportWidth - width - sideGap),
    y: Math.max(sideGap, viewportHeight - height - bottomGap),
  };
}

function clampFabPosition(position = {}, fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const margin = _isMobile() ? 10 : 8;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  const x = Number.isFinite(position?.x) ? position.x : maxX;
  const y = Number.isFinite(position?.y) ? position.y : maxY;

  return {
    x: Math.min(Math.max(margin, Math.round(x)), Math.round(maxX)),
    y: Math.min(Math.max(margin, Math.round(y)), Math.round(maxY)),
  };
}

function applyFabPosition(position = {}, fab = _fabEl) {
  if (!fab) return;
  const clamped = clampFabPosition(position, fab);
  fab.style.left = `${clamped.x}px`;
  fab.style.top = `${clamped.y}px`;
  fab.style.right = "auto";
  fab.style.bottom = "auto";
}

function syncFabPosition() {
  if (!_fabEl) return;

  ensureFabMountedAtRoot();
  const mode = _fabEl.dataset.positionMode || "default";
  if (mode === "saved") {
    const currentX = Number.parseFloat(_fabEl.style.left);
    const currentY = Number.parseFloat(_fabEl.style.top);
    const fallback =
      _loadFabPosition() ||
      getDefaultFabPosition(_fabEl);
    const next = clampFabPosition(
      {
        x: Number.isFinite(currentX) ? currentX : fallback.x,
        y: Number.isFinite(currentY) ? currentY : fallback.y,
      },
      _fabEl,
    );
    applyFabPosition(next, _fabEl);
    _saveFabPosition(next.x, next.y);
    return;
  }

  applyFabPosition(getDefaultFabPosition(_fabEl), _fabEl);
}

function bindViewportSync() {
  if (viewportSyncBound) return;
  viewportSyncBound = true;

  const update = () => {
    syncViewportCssVars();
    syncFabPosition();
    if (!_isMobile() && currentTabId === "graph") {
      _switchTab("dashboard");
    }
  };
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
}

function _getVisibleGraphWorkspaceMode() {
  return resolveVisibleGraphWorkspaceMode({
    overlayActive: overlayEl?.classList.contains("active") === true,
    isMobile: _isMobile(),
    currentTabId,
    currentGraphView,
    currentMobileGraphView,
  });
}

function _getCurrentGraphRefreshToken() {
  const graph = _getGraph?.();
  const persistence = _getGraphPersistenceSnapshot();
  return buildVisibleGraphRefreshToken({
    visibleMode: _getVisibleGraphWorkspaceMode(),
    chatId: persistence?.chatId,
    loadState: persistence?.loadState,
    revision:
      persistence?.revision ??
      persistence?.lastAcceptedRevision ??
      persistence?.lastSyncedRevision ??
      0,
    nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : -1,
    edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : -1,
    lastProcessedSeq: graph?.historyState?.lastProcessedAssistantFloor ?? -1,
  });
}

function _clearScheduledVisibleGraphRefresh() {
  if (pendingVisibleGraphRefreshTimer) {
    clearTimeout(pendingVisibleGraphRefreshTimer);
    pendingVisibleGraphRefreshTimer = null;
  }
  pendingVisibleGraphRefreshToken = "";
  pendingVisibleGraphRefreshForce = false;
}

function _isGraphRenderingEnabled() {
  return graphRenderingEnabled !== false;
}

function _buildGraphRuntimeConfig(settings = _getSettings?.() || {}) {
  return {
    graphUseNativeLayout: settings.graphUseNativeLayout === true,
    graphNativeLayoutThresholdNodes: Number.isFinite(
      Number(settings.graphNativeLayoutThresholdNodes),
    )
      ? Math.max(1, Math.floor(Number(settings.graphNativeLayoutThresholdNodes)))
      : 280,
    graphNativeLayoutThresholdEdges: Number.isFinite(
      Number(settings.graphNativeLayoutThresholdEdges),
    )
      ? Math.max(1, Math.floor(Number(settings.graphNativeLayoutThresholdEdges)))
      : 1600,
    graphNativeLayoutWorkerTimeoutMs: Number.isFinite(
      Number(settings.graphNativeLayoutWorkerTimeoutMs),
    )
      ? Math.max(40, Math.floor(Number(settings.graphNativeLayoutWorkerTimeoutMs)))
      : 260,
    nativeEngineFailOpen: settings.nativeEngineFailOpen !== false,
    graphNativeForceDisable: settings.graphNativeForceDisable === true,
  };
}

function _applyGraphRuntimeConfig(settings = _getSettings?.() || {}) {
  const runtimeConfig = _buildGraphRuntimeConfig(settings);
  graphRenderer?.setRuntimeConfig?.(runtimeConfig);
  mobileGraphRenderer?.setRuntimeConfig?.(runtimeConfig);
  return runtimeConfig;
}

function _refreshGraphRenderToggleUi() {
  const enabled = _isGraphRenderingEnabled();
  const syncButton = (button) => {
    if (!button) return;
    const title = enabled ? "Tạm dừng dựng đồ thị" : "Khôi phục dựng đồ thị";
    button.classList.toggle("is-paused", !enabled);
    button.classList.toggle("is-active", enabled);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    const icon = button.querySelector("i");
    if (icon) {
      icon.className = enabled ? "fa-solid fa-pause" : "fa-solid fa-play";
    }
  };
  syncButton(document.getElementById("bme-graph-render-toggle"));
  syncButton(document.getElementById("bme-mobile-render-toggle"));
}

function _applyGraphRenderEnabledState({ forceRefresh = false } = {}) {
  const enabled = _isGraphRenderingEnabled();
  graphRenderer?.setEnabled?.(enabled);
  mobileGraphRenderer?.setEnabled?.(enabled);
  _refreshGraphRenderToggleUi();
  if (!enabled) {
    _clearScheduledVisibleGraphRefresh();
    return;
  }
  if (forceRefresh) {
    _scheduleVisibleGraphWorkspaceRefresh({ force: true });
  }
}

function _toggleGraphRenderingEnabled() {
  graphRenderingEnabled = !_isGraphRenderingEnabled();
  _applyGraphRenderEnabledState({ forceRefresh: graphRenderingEnabled });
  _refreshGraphAvailabilityState();
}

function _refreshVisibleGraphWorkspace({ force = false } = {}) {
  const visibleMode = _getVisibleGraphWorkspaceMode();
  if (visibleMode === "hidden") {
    _refreshGraphLayoutDiagnosticsUi();
    return { refreshed: false, reason: "hidden" };
  }

  const graph = _getGraph?.();
  const nextToken = _getCurrentGraphRefreshToken();
  if (!force && nextToken === lastVisibleGraphRefreshToken) {
    return { refreshed: false, reason: "unchanged", token: nextToken };
  }

  const hints = { userPovAliases: _hostUserPovAliasHintsForGraph() };
  if (visibleMode === "desktop:graph") {
    if (graph && graphRenderer) {
      graphRenderer.loadGraph(graph, hints);
    }
  } else if (visibleMode === "desktop:cognition") {
    _refreshCognitionWorkspace();
  } else if (visibleMode === "desktop:summary") {
    _refreshSummaryWorkspace();
  } else if (visibleMode === "mobile:graph") {
    if (graph && mobileGraphRenderer) {
      mobileGraphRenderer.loadGraph(graph, hints);
    }
    _buildMobileLegend();
  } else if (visibleMode === "mobile:cognition") {
    _refreshMobileCognitionFull();
  } else if (visibleMode === "mobile:summary") {
    _refreshMobileSummaryFull();
  }

  _refreshGraphLayoutDiagnosticsUi();

  lastVisibleGraphRefreshToken = nextToken;
  lastVisibleGraphRefreshAt = Date.now();
  return {
    refreshed: true,
    reason: force ? "forced" : "changed",
    token: nextToken,
    visibleMode,
  };
}

function _flushScheduledVisibleGraphRefresh() {
  const shouldForce = pendingVisibleGraphRefreshForce === true;
  _clearScheduledVisibleGraphRefresh();
  return _refreshVisibleGraphWorkspace({ force: shouldForce });
}

function _scheduleVisibleGraphWorkspaceRefresh({ force = false } = {}) {
  const nextToken = _getCurrentGraphRefreshToken();
  if (nextToken === "hidden") {
    _clearScheduledVisibleGraphRefresh();
    return { scheduled: false, reason: "hidden" };
  }

  if (force) {
    _clearScheduledVisibleGraphRefresh();
    return _refreshVisibleGraphWorkspace({ force: true });
  }

  if (nextToken === lastVisibleGraphRefreshToken) {
    return { scheduled: false, reason: "unchanged", token: nextToken };
  }

  if (
    pendingVisibleGraphRefreshTimer &&
    pendingVisibleGraphRefreshToken === nextToken &&
    pendingVisibleGraphRefreshForce !== true
  ) {
    return { scheduled: true, reason: "pending", token: nextToken };
  }

  const delay = Math.max(
    0,
    GRAPH_LIVE_REFRESH_THROTTLE_MS - (Date.now() - lastVisibleGraphRefreshAt),
  );
  pendingVisibleGraphRefreshToken = nextToken;
  pendingVisibleGraphRefreshForce = false;

  if (pendingVisibleGraphRefreshTimer) {
    clearTimeout(pendingVisibleGraphRefreshTimer);
    pendingVisibleGraphRefreshTimer = null;
  }

  if (delay <= 0) {
    return _flushScheduledVisibleGraphRefresh();
  }

  pendingVisibleGraphRefreshTimer = setTimeout(() => {
    _flushScheduledVisibleGraphRefresh();
  }, delay);

  return {
    scheduled: true,
    reason: "throttled",
    token: nextToken,
    delay,
  };
}

/**
 * Khởi tạo bảng (được index.js gọi một lần)
 */
export async function initPanel({
  getGraph,
  getSettings,
  getLastExtract,
  getLastBatchStatus,
  getLastRecall,
  getRuntimeStatus,
  getLastExtractionStatus,
  getLastVectorStatus,
  getLastRecallStatus,
  getLastInjection,
  getRuntimeDebugSnapshot,
  getGraphPersistenceState,
  updateSettings,
  actions,
}) {
  _getGraph = getGraph;
  _getSettings = getSettings;
  _getLastExtract = getLastExtract;
  _getLastBatchStatus = getLastBatchStatus;
  _getLastRecall = getLastRecall;
  _getRuntimeStatus = getRuntimeStatus;
  _getLastExtractionStatus = getLastExtractionStatus;
  _getLastVectorStatus = getLastVectorStatus;
  _getLastRecallStatus = getLastRecallStatus;
  _getLastInjection = getLastInjection;
  _getRuntimeDebugSnapshot = getRuntimeDebugSnapshot;
  _getGraphPersistenceState = getGraphPersistenceState;
  _updateSettings = updateSettings;
  _actionHandlers = actions || {};

  overlayEl = document.getElementById("st-bme-panel-overlay");
  panelEl = document.getElementById("st-bme-panel");

  if (!overlayEl || !panelEl) {
    const html = await loadLocalTemplate("panel");
    mountPanelHtml(html);
    overlayEl = document.getElementById("st-bme-panel-overlay");
    panelEl = document.getElementById("st-bme-panel");
    if (!overlayEl || !panelEl) {
      throw new Error(
        "Panel template rendered but required DOM nodes were not found",
      );
    }
  }

  ensureOverlayMountedAtRoot();
  bindViewportSync();
  syncViewportCssVars();

  _bindTabs();
  _bindClose();
  _bindNodeDetailPanel();
  _bindMemoryPopup();
  _bindResizeHandle();
  _bindPanelResize();
  _bindGraphControls();
  _bindActions();
  _bindDashboardControls();
  _bindConfigControls();
  _bindTaskNavigation();
  _bindPlannerLauncher();
  currentTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || "dashboard";
  _applyWorkspaceMode();
  _syncConfigSectionState();
  _syncTaskSectionState();
  _refreshRuntimeStatus();
  _initFloatingBall();
  _bindFabToggle();
}

// ==================== Bóng nổi ====================

const FAB_STORAGE_KEY = "bme-fab-position";
const FAB_VISIBLE_KEY = "bme-fab-visible";
let _fabEl = null;

function _getFabVisible() {
  try {
    const val = localStorage.getItem(FAB_VISIBLE_KEY);
    return val === null ? true : val === "true";
  } catch { return true; }
}

function _setFabVisible(visible) {
  try { localStorage.setItem(FAB_VISIBLE_KEY, String(visible)); } catch {}
  if (_fabEl) {
    ensureFabMountedAtRoot();
    _fabEl.style.display = visible ? "flex" : "none";
    if (visible) {
      syncFabPosition();
    }
  }
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (btn) btn.setAttribute("data-active", String(visible));
}

function _bindFabToggle() {
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (!btn) return;
  btn.setAttribute("data-active", String(_getFabVisible()));
  btn.addEventListener("click", () => {
    const next = !_getFabVisible();
    _setFabVisible(next);
  });
}

function _initFloatingBall() {
  let fab = document.getElementById("bme-floating-ball");
  if (!fab) {
    fab = document.createElement("div");
    fab.id = "bme-floating-ball";
    fab.setAttribute("data-status", "idle");
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME đồ thị ký ức</span>
    `;
  } else if (!fab.querySelector(".bme-fab-icon")) {
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME đồ thị ký ức</span>
    `;
  }
  _fabEl = fab;
  ensureFabMountedAtRoot();

  // Áp dụng trạng thái hiển thị
  if (!_getFabVisible()) fab.style.display = "none";

  // Khôi phục vị trí
  const saved = _loadFabPosition();
  if (saved) {
    fab.dataset.positionMode = "saved";
    applyFabPosition(saved, fab);
  } else if (!fab.style.left || !fab.style.top) {
    fab.dataset.positionMode = "default";
    syncFabPosition();
  }

  if (fab.dataset.bmeFabBound === "true") {
    return;
  }
  fab.dataset.bmeFabBound = "true";
  delete fab.dataset.bmeBootstrap;

  // Logic kéo thả + click
  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0;
  let fabStartX = 0, fabStartY = 0;
  let clickTimer = null;

  const DRAG_THRESHOLD = 5;
  const DBLCLICK_DELAY = 280;

  function onPointerDown(e) {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartX = rect.left;
    fabStartY = rect.top;
    fab.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    hasMoved = true;

    applyFabPosition(
      {
        x: fabStartX + dx,
        y: fabStartY + dy,
      },
      fab,
    );
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    fab.releasePointerCapture(e.pointerId);

    if (hasMoved) {
      // Kéo thả kết thúc → lưu vị trí
      fab.dataset.positionMode = "saved";
      _saveFabPosition(
        Number.parseInt(fab.style.left, 10),
        Number.parseInt(fab.style.top, 10),
      );
      return;
    }

    // Không kéo thả → xử lý click đơn/double click
    if (clickTimer) {
      // Click lần hai → double click → re-roll
      clearTimeout(clickTimer);
      clickTimer = null;
      _onFabDoubleClick();
    } else {
      // Click lần đầu → chờ double click
      clickTimer = setTimeout(() => {
        clickTimer = null;
        _onFabSingleClick();
      }, DBLCLICK_DELAY);
    }
  }

  fab.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
}

function _onFabSingleClick() {
  openPanel();
}

async function _onFabDoubleClick() {
  if (!_actionHandlers.extractTask) return;

  try {
    _fabEl?.setAttribute("data-status", "running");
    await _actionHandlers.extractTask({ mode: "rerun" });
    _fabEl?.setAttribute("data-status", "success");
    _refreshDashboard();
    _refreshGraph();
    setTimeout(() => {
      const status = _getRuntimeStatus?.() || {};
      _fabEl?.setAttribute("data-status", status.status || "idle");
    }, 3000);
  } catch (err) {
    console.error("[ST-BME] FAB extract task failed:", err);
    _fabEl?.setAttribute("data-status", "error");
  }
}

function _loadFabPosition() {
  try {
    const raw = localStorage.getItem(FAB_STORAGE_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
  } catch {}
  return null;
}

function _saveFabPosition(x, y) {
  try {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {}
}

export function updateFloatingBallStatus(status = "idle", tooltipText = "") {
  if (!_fabEl) return;
  _fabEl.setAttribute("data-status", status);
  if (tooltipText) {
    const tip = _fabEl.querySelector(".bme-fab-tooltip");
    if (tip) tip.textContent = tooltipText;
  }
}

/**
 * Mở bảng
 */
export function openPanel() {
  if (!overlayEl) return;
  ensureOverlayMountedAtRoot();
  syncViewportCssVars();
  _actionHandlers.syncGraphLoad?.();
  overlayEl.classList.add("active");

  _restorePanelSize();

  const isMobile = _isMobile();
  const settings = _getSettings?.() || {};
  const themeName = settings.panelTheme || "crimson";

  const graphOpts = {
    theme: themeName,
    userPovAliases: _hostUserPovAliasHintsForGraph(),
    runtimeConfig: _buildGraphRuntimeConfig(settings),
  };
  const canvas = document.getElementById("bme-graph-canvas");
  if (canvas && !graphRenderer && !isMobile) {
    graphRenderer = new GraphRenderer(canvas, graphOpts);
    graphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const mobileCanvas = document.getElementById("bme-mobile-graph-canvas");
  if (mobileCanvas && !mobileGraphRenderer && isMobile) {
    mobileGraphRenderer = new GraphRenderer(mobileCanvas, graphOpts);
    mobileGraphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  _applyGraphRuntimeConfig(settings);

  _applyGraphRenderEnabledState();

  const activeTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || currentTabId;
  _switchTab(activeTabId);
  _refreshRuntimeStatus();
  _buildLegend();
}

/**
 * Đóng bảng
 */
export function closePanel() {
  if (!overlayEl) return;
  overlayEl.classList.remove("active");
  _closeMemoryPopup();
  _clearScheduledVisibleGraphRefresh();
  lastVisibleGraphRefreshToken = "";
}

/**
 * Cập nhật chủ đề
 */
export function updatePanelTheme(themeName) {
  graphRenderer?.setTheme(themeName);
  mobileGraphRenderer?.setTheme(themeName);
  _buildLegend();
  _highlightThemeChoice(themeName);
}

export function refreshLiveState() {
  if (!overlayEl?.classList.contains("active")) return;
  _applyGraphRuntimeConfig(_getSettings?.() || {});
  _refreshRuntimeStatus();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "task":
      _refreshTaskMonitor();
      break;
    default:
      break;
  }

  if (
    currentTabId === "config" &&
    currentConfigSectionId === "prompts" &&
    currentTaskProfileTabId === "debug"
  ) {
    _refreshTaskProfileWorkspace();
  }

  _scheduleVisibleGraphWorkspaceRefresh();
}

// ==================== Chuyển Tab ====================

function _bindTabs() {
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      _switchTab(tabId);
    });
  });
}

function _switchTab(tabId) {
  const previousVisibleGraphMode = _getVisibleGraphWorkspaceMode();
  let next = tabId || "dashboard";
  // Tab “Đồ thị” chỉ khả dụng ở thanh tab dưới trên thiết bị di động; ở desktop đồ thị nằm trong vùng làm việc chính bên phải nên thanh bên không có tab này
  if (!_isMobile() && next === "graph") {
    next = "dashboard";
  }
  currentTabId = next;
  _closeNodeDetailUi();
  _closeMemoryPopup();
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentTabId);
  });

  panelEl?.querySelectorAll(".bme-tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `bme-pane-${currentTabId}`);
  });

  _applyWorkspaceMode();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "task":
      _refreshTaskMonitor();
      break;
    case "config":
      _refreshConfigTab();
      break;
    case "graph":
      break;
    default:
      break;
  }

  const nextVisibleGraphMode = _getVisibleGraphWorkspaceMode();
  if (nextVisibleGraphMode !== previousVisibleGraphMode) {
    _scheduleVisibleGraphWorkspaceRefresh({ force: true });
  } else {
    _scheduleVisibleGraphWorkspaceRefresh();
  }
}

function _getPlannerApi() {
  return globalThis?.stBmeEnaPlanner || null;
}

function _refreshPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  const hint = document.getElementById("bme-open-ena-planner-hint");
  if (!button || !hint) return;

  const plannerApi = _getPlannerApi();
  const ready = typeof plannerApi?.openSettings === "function";

  button.disabled = !ready;
  button.classList.toggle("is-runtime-disabled", !ready);
  hint.textContent = ready
    ? "Đã tải xong, có thể mở trang Cài đặt Ena Planner độc lập."
    : "Không phát hiện được mô-đun Ena Planner, vui lòng tải lại ST-BME rồi thử lại.";
}

function _bindPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  if (!button || button.dataset.bmeBound === "true") {
    _refreshPlannerLauncher();
    return;
  }

  button.addEventListener("click", () => {
    const plannerApi = _getPlannerApi();
    if (typeof plannerApi?.openSettings === "function") {
      plannerApi.openSettings();
    }
    _refreshPlannerLauncher();
  });

  button.dataset.bmeBound = "true";
  _refreshPlannerLauncher();
}

function _applyWorkspaceMode() {
  if (!panelEl) return;
  const isConfig = currentTabId === "config";
  const isTask = currentTabId === "task";
  panelEl.classList.toggle("config-mode", isConfig);
  panelEl.classList.toggle("task-mode", isTask);
}

// ==================== Không gian giám sát tác vụ ====================

const TASK_SECTION_META = {
  pipeline: { kicker: "Tổng quan pipeline", title: "Tổng quan pipeline", desc: "Xem trạng thái chạy của toàn bộ pipeline tác vụ và tiến độ của lô hiện tại theo thời gian thực." },
  timeline: { kicker: "Dòng thời gian tác vụ", title: "Dòng thời gian tác vụ", desc: "Theo dõi bản ghi thực thi của từng lần trích xuất, truy hồi, lập chỉ mục vector theo trục thời gian." },
  memory: { kicker: "Duyệt ký ức", title: "Duyệt ký ức", desc: "Duyệt và tìm kiếm toàn bộ nút ký ức trong đồ thị." },
  injection: { kicker: "Xem trước tiêm", title: "Xem trước tiêm", desc: "Xem bản xem trước nội dung vừa tiêm vào AI chính gần nhất cùng mức dùng token." },
  trace: { kicker: "Theo dõi tin nhắn", title: "Theo dõi tin nhắn", desc: "Lượt này rốt cuộc đã gửi gì? Xem snapshot tiêm truy hồi và chi tiết yêu cầu trích xuất." },
  persistence: { kicker: "Lưu bền", title: "Trạng thái lưu bền", desc: "Trạng thái tải đồ thị, tầng lưu trữ, dấu commit và các thao tác sửa chữa." },
};

function _bindTaskNavigation() {
  panelEl?.querySelectorAll(".bme-task-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _switchTaskSection(btn.dataset.taskSection);
    });
  });
  panelEl?.querySelectorAll(".bme-task-nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      _switchTaskSection(btn.dataset.taskSection);
    });
  });
}

function _switchTaskSection(sectionId) {
  currentTaskSectionId = sectionId || "pipeline";
  _closeMemoryPopup();
  _syncTaskSectionState();
  _refreshTaskMonitor();
}

function _syncTaskSectionState() {
  panelEl?.querySelectorAll(".bme-task-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.taskSection === currentTaskSectionId);
  });
  panelEl?.querySelectorAll(".bme-task-nav-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.taskSection === currentTaskSectionId);
  });
  panelEl?.querySelectorAll(".bme-task-section").forEach((section) => {
    section.classList.toggle("active", section.dataset.taskSection === currentTaskSectionId);
  });
  const meta = TASK_SECTION_META[currentTaskSectionId] || TASK_SECTION_META.pipeline;
  const kicker = document.getElementById("bme-task-ws-kicker");
  const title = document.getElementById("bme-task-ws-title");
  const desc = document.getElementById("bme-task-ws-desc");
  if (kicker) kicker.textContent = meta.kicker;
  if (title) title.textContent = meta.title;
  if (desc) desc.textContent = meta.desc;
}

function _refreshTaskMonitor() {
  switch (currentTaskSectionId) {
    case "pipeline":
      _refreshTaskPipelineOverview();
      break;
    case "timeline":
      _refreshTaskTimeline();
      break;
    case "memory":
      _refreshTaskMemoryBrowser();
      break;
    case "injection":
      _refreshTaskInjectionPreview();
      break;
    case "trace":
      _refreshTaskMessageTrace();
      break;
    case "persistence":
      _refreshTaskPersistence();
      break;
  }
}

// ---------- Pipeline Overview ----------

function _resolvePipelineStatus(statusObj) {
  if (!statusObj) return { label: "UNKNOWN", color: "amber", detail: "—" };
  const text = String(statusObj.text || "");
  const meta = String(statusObj.meta || "");
  const level = String(statusObj.level || "info");
  let color = "green";
  if (level === "warn") color = "amber";
  else if (level === "error") color = "red";
  else if (text.toLowerCase().includes("running") || text.toLowerCase().includes("đang diễn raTrung bình") || text.includes("đang")) color = "cyan";
  return { label: text || "IDLE", color, detail: meta };
}

function _refreshTaskPipelineOverview() {
  const el = document.getElementById("bme-task-pipeline");
  if (!el) return;

  const graph = _getGraph?.() || {};
  const historyState = graph.runtimeState?.historyState || graph.historyState || {};
  const loadInfo = _getGraphPersistenceSnapshot();

  const extraction = _resolvePipelineStatus(_getLastExtractionStatus?.());
  const vector = _resolvePipelineStatus(_getLastVectorStatus?.());
  const recall = _resolvePipelineStatus(_getLastRecallStatus?.());
  const persistLevel = loadInfo.loadState === "loaded" ? "info" : loadInfo.loadState === "loading" ? "info" : "warn";
  const persistence = _resolvePipelineStatus({
    text: loadInfo.loadState || "unknown",
    meta: `rev ${loadInfo.revision || 0}`,
    level: persistLevel,
  });

  const batchStatus = _getLatestBatchStatusSnapshot() || {};
  const stages = [
    { key: "core", label: "Core" },
    { key: "structural", label: "Cấu trúc" },
    { key: "semantic", label: "Ngữ nghĩa" },
    { key: "finalize", label: "Hoàn thiện" },
  ];

  const stageHtml = stages.map((s, i) => {
    const outcome = batchStatus.stageOutcomes?.[s.key];
    let dotClass = "";
    let lineClass = "";
    let icon = '<i class="fa-solid fa-hourglass"></i>';
    if (outcome === "success" || outcome === "skipped") {
      dotClass = "done";
      icon = '<i class="fa-solid fa-check"></i>';
      lineClass = "done";
    } else if (outcome === "running" || outcome === "partial") {
      dotClass = "running";
      icon = '<i class="fa-solid fa-spinner fa-spin"></i>';
      lineClass = "running";
    }
    const linePart = i < stages.length - 1 ? `<div class="bme-batch-stage-line ${lineClass}"></div>` : "";
    return `
      <div class="bme-batch-stage">
        <div class="bme-batch-stage-dot ${dotClass}">${icon}</div>
        <div class="bme-batch-stage-label">${_escHtml(s.label)}</div>
        <div class="bme-batch-stage-detail">${outcome ? _escHtml(outcome) : "pending"}</div>
        ${linePart}
      </div>
    `;
  }).join("");

  const batchMeta = batchStatus.persistenceOutcome
    ? `<span><i class="fa-solid fa-database"></i> ${_escHtml(batchStatus.persistenceOutcome)}</span>`
    : "";
  const batchWarnings = (batchStatus.warnings || []).length;
  const batchErrors = (batchStatus.errors || []).length;
  const batchMetaExtra = [
    batchWarnings ? `<span><i class="fa-solid fa-triangle-exclamation"></i> ${batchWarnings} warnings</span>` : "",
    batchErrors ? `<span><i class="fa-solid fa-circle-exclamation"></i> ${batchErrors} errors</span>` : "",
  ].filter(Boolean).join("");

  const statusRows = [
    { label: "Trích xuất", color: extraction.color, value: extraction.label + (extraction.detail ? ` — ${extraction.detail}` : "") },
    { label: "Vector", color: vector.color, value: vector.label + (vector.detail ? ` — ${vector.detail}` : "") },
    { label: "Truy hồi", color: recall.color, value: recall.label + (recall.detail ? ` — ${recall.detail}` : "") },
    { label: "Lưu bền", color: persistence.color, value: persistence.label + (persistence.detail ? ` — ${persistence.detail}` : "") },
  ];

  const pipelineCard = (name, s, icon) => `
    <div class="bme-pipeline-card" data-status="${s.color === "green" ? "idle" : s.color === "cyan" ? "running" : s.color === "amber" ? "warning" : "error"}">
      <div class="bme-pipeline-dot ${s.color}"></div>
      <div class="bme-pipeline-info">
        <div class="bme-pipeline-name"><i class="fa-solid fa-${icon}" style="margin-right:4px;opacity:.5"></i>${_escHtml(name)}</div>
        <div class="bme-pipeline-status ${s.color}">${_escHtml(s.label)}</div>
        <div class="bme-pipeline-detail">${_escHtml(s.detail)}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="bme-pipeline-grid">
      ${pipelineCard("Trích xuất Extraction", extraction, "scissors")}
      ${pipelineCard("Vector Vector", vector, "share-nodes")}
      ${pipelineCard("Truy hồi Recall", recall, "magnifying-glass")}
      ${pipelineCard("Lưu bền Persistence", persistence, "database")}
    </div>
    <div class="bme-batch-progress">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:12px;font-weight:700;color:var(--bme-on-surface)"><i class="fa-solid fa-timeline" style="margin-right:6px;color:var(--bme-primary)"></i>Active Batch Progress</span>
        <span style="font-size:10px;color:var(--bme-on-surface-dim)">ID: ${_escHtml(String(batchStatus.batchId || "—"))}</span>
      </div>
      <div class="bme-batch-stages">${stageHtml}</div>
      <div class="bme-batch-meta">${batchMeta}${batchMetaExtra}</div>
    </div>
    <div class="bme-status-summary">
      <div class="bme-status-summary-title"><i class="fa-solid fa-list"></i> Recent Status</div>
      ${statusRows.map((r) => `
        <div class="bme-status-row">
          <div class="bme-status-row-label"><span class="bme-sdot" style="background:${r.color === "green" ? "#2ecc71" : r.color === "cyan" ? "#00d4ff" : r.color === "amber" ? "#f39c12" : "#e74c3c"}"></span>${_escHtml(r.label)}</div>
          <div class="bme-status-row-value">${_escHtml(r.value)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

// ---------- Task Timeline ----------

function _getTaskTimelineEntrySeverity(entry = {}) {
  const explicitLevel = String(entry?.level || "").trim().toLowerCase();
  if (explicitLevel) return explicitLevel;

  const status = String(entry?.status || "").trim().toLowerCase();
  if (status.includes("error") || status.includes("fail")) return "error";
  if (status.includes("warn")) return "warn";
  return "info";
}

function _buildTaskTimelineDetailState(entry = {}) {
  const detailLines = [];
  const legacyDetail = String(entry?.text || entry?.meta || "").trim();
  const routeInfo = _formatMonitorRouteInfo(entry);
  const governanceLines = _summarizeMonitorGovernance(entry);
  const messageCount = Array.isArray(entry?.messages) ? entry.messages.length : 0;
  const rawPreviewText = _buildMonitorMessagesPreview(entry?.messages || []);
  const previewText =
    rawPreviewText.length > 480
      ? `${rawPreviewText.slice(0, 480)}\n\n...(chi tiết đã bị cắt bớt)`
      : rawPreviewText;

  if (legacyDetail) {
    detailLines.push(legacyDetail);
  }
  if (routeInfo && routeInfo !== "Chưa ghi nhận thông tin định tuyến") {
    detailLines.push(`Định tuyến: ${routeInfo}`);
  }
  for (const line of governanceLines) {
    const normalized = String(line || "").trim();
    if (normalized) detailLines.push(normalized);
  }
  if (messageCount > 0) {
    detailLines.push(`Message snapshot: ${messageCount} mục`);
  }

  const uniqueLines = [];
  for (const line of detailLines) {
    if (!uniqueLines.includes(line)) {
      uniqueLines.push(line);
    }
  }

  return {
    detailLines: uniqueLines,
    previewText,
    hasRenderableDetail: uniqueLines.length > 0 || Boolean(previewText),
  };
}

function _refreshTaskTimeline() {
  const el = document.getElementById("bme-task-timeline");
  if (!el) return;

  const debug = _getRuntimeDebugSnapshot?.() || {};
  const rd = debug.runtimeDebug || {};
  const timeline = Array.isArray(rd.taskTimeline) ? rd.taskTimeline : [];

  if (!timeline.length) {
    el.innerHTML = '<div class="bme-timeline-bottom-bar">Chưa có bản ghi tác vụ</div>';
    return;
  }

  const entries = timeline.slice().reverse().map((entry, idx) => {
    const t = entry.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString() : "";
    const taskType = String(entry?.taskType || entry?.stage || "task");
    const title = entry?.taskType
      ? _getMonitorTaskTypeLabel(taskType)
      : taskType;
    const statusText = entry.status || "";
    const durationMs = entry.durationMs;
    const durationStr = _formatDurationMs(durationMs);
    const { detailLines, previewText, hasRenderableDetail } =
      _buildTaskTimelineDetailState(entry);
    const level = _getTaskTimelineEntrySeverity(entry);
    const levelIcon = level === "error" ? "circle-exclamation" : level === "warn" ? "triangle-exclamation" : "circle-check";
    const levelColor = level === "error" ? "#e74c3c" : level === "warn" ? "#f39c12" : "#2ecc71";
    const metaParts = [
      durationStr && durationStr !== "—" ? durationStr : "",
      t,
    ].filter(Boolean);

    const substages = Array.isArray(entry.substages) ? entry.substages.map((sub) => `
      <div class="bme-timeline-substage">
        <i class="fa-solid fa-angle-right" style="color:${levelColor}"></i>
        <span>${_escHtml(sub.label || sub.stage || "")}</span>
        <span style="margin-left:auto;opacity:.5">${_escHtml(sub.outcome || sub.status || "")}</span>
      </div>
    `).join("") : "";

    return `
      <div class="bme-timeline-entry${idx > 5 ? " is-collapsed" : ""}" data-entry-idx="${idx}">
        <div class="bme-timeline-entry__head">
          <i class="fa-solid fa-${levelIcon}" style="color:${levelColor};font-size:12px"></i>
          <span class="bme-timeline-entry__title">${_escHtml(title)}${statusText ? ` — ${_escHtml(_getMonitorStatusLabel(statusText))}` : ""}</span>
          <span class="bme-timeline-entry__meta">${_escHtml(metaParts.join(" "))}</span>
          <button class="bme-timeline-entry__toggle" type="button"><i class="fa-solid fa-chevron-down"></i></button>
        </div>
        <div class="bme-timeline-entry__detail">
          ${detailLines.map((line) => `<div class="bme-timeline-entry__line">${_escHtml(line)}</div>`).join("")}
          ${substages}
          ${previewText ? `<div class="bme-timeline-entry__preview">${_escHtml(previewText)}</div>` : ""}
          ${!hasRenderableDetail && !substages ? `<div class="bme-timeline-entry__empty">Bản ghi này không bắt được thêm chi tiết nào; thường nghĩa là hiện chỉ giữ lại snapshot trạng thái tác vụ.</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="bme-timeline-toolbar">
      <i class="fa-solid fa-filter" style="color:var(--bme-on-surface-dim);font-size:11px"></i>
      <span style="font-size:11px;color:var(--bme-on-surface-dim)">${timeline.length} bản ghi</span>
    </div>
    <div class="bme-timeline-stack">${entries}</div>
  `;
}

// ---------- Memory Browser (Master-Detail) ----------

function _getMemoryNodeTypeClass(type) {
  switch (type) {
    case "pov_memory":
    case "character":
      return "type-character";
    case "event":
      return "type-event";
    case "location":
      return "type-location";
    case "rule":
      return "type-rule";
    case "thread":
      return "type-thread";
    default:
      return "type-default";
  }
}

function _parseFloorFilter(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const ranges = [];
  for (const part of text.split(/[,，\s]+/)) {
    const rangeParts = part.split(/[-~]/);
    if (rangeParts.length === 2) {
      const lo = parseInt(rangeParts[0], 10);
      const hi = parseInt(rangeParts[1], 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
        ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
      }
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    }
  }
  return ranges.length ? ranges : null;
}

function _matchesFloorFilter(node, ranges) {
  const seq = node.seq ?? -1;
  const seqLo = node.seqRange?.[0] ?? seq;
  const seqHi = node.seqRange?.[1] ?? seq;
  for (const [lo, hi] of ranges) {
    if (seqHi >= lo && seqLo <= hi) return true;
  }
  return false;
}

function _createTaskMemorySearchState(overrides = {}) {
  return {
    query: String(overrides.query || ""),
    floorQuery: String(overrides.floorQuery || ""),
    filter: String(overrides.filter || "all") || "all",
  };
}

function _readTaskMemoryDraftFromControls() {
  taskMemorySearchDraft = _createTaskMemorySearchState({
    query: document.getElementById("bme-task-memory-search")?.value,
    floorQuery: document.getElementById("bme-task-memory-floor")?.value,
    filter: document.getElementById("bme-task-memory-filter")?.value,
  });
  return _createTaskMemorySearchState(taskMemorySearchDraft);
}

function _applyTaskMemorySearchDraft() {
  taskMemorySearchApplied = _readTaskMemoryDraftFromControls();
  _refreshTaskMemoryBrowser();
}

function _ensureTaskMemoryBrowserShell(el) {
  if (!el) return null;

  let listEl = document.getElementById("bme-task-memory-list");
  let detailEl = document.getElementById("bme-task-memory-detail");
  if (!listEl || !detailEl) {
    const draft = _createTaskMemorySearchState(taskMemorySearchDraft);
    el.innerHTML = `
      <div class="bme-memory-master-detail">
        <div class="bme-memory-list-panel">
          <div class="bme-memory-list-filters">
            <input type="text" class="bme-search-input" id="bme-task-memory-search" placeholder="Tìm kiếm nút ký ức..." value="${_escHtml(draft.query)}" />
            <input type="text" class="bme-search-input bme-floor-input" id="bme-task-memory-floor" placeholder="Tầng (ví dụ 4, 3-10)" value="${_escHtml(draft.floorQuery)}" />
            <select class="bme-filter-select" id="bme-task-memory-filter">
              <option value="all"${draft.filter === "all" ? " selected" : ""}>Tất cả</option>
              <option value="scope:objective"${draft.filter === "scope:objective" ? " selected" : ""}>Khách quan</option>
              <option value="scope:characterPov"${draft.filter === "scope:characterPov" ? " selected" : ""}>POV nhân vật</option>
              <option value="scope:userPov"${draft.filter === "scope:userPov" ? " selected" : ""}>POV người dùng</option>
              <option value="pov_memory"${draft.filter === "pov_memory" ? " selected" : ""}>Ký ức chủ quan</option>
              <option value="event"${draft.filter === "event" ? " selected" : ""}>Sự kiện</option>
              <option value="location"${draft.filter === "location" ? " selected" : ""}>Địa điểm</option>
              <option value="thread"${draft.filter === "thread" ? " selected" : ""}>Manh mối</option>
              <option value="rule"${draft.filter === "rule" ? " selected" : ""}>Quy tắc</option>
            </select>
            <button
              type="button"
              class="bme-config-secondary-btn bme-task-memory-search-btn"
              id="bme-task-memory-apply"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
              <span>Tìm kiếm</span>
            </button>
          </div>
          <div class="bme-memory-list-scroll" id="bme-task-memory-list"></div>
        </div>
        <div class="bme-memory-detail-panel" id="bme-task-memory-detail"></div>
      </div>
    `;
    listEl = document.getElementById("bme-task-memory-list");
    detailEl = document.getElementById("bme-task-memory-detail");
  }

  const searchInput = document.getElementById("bme-task-memory-search");
  const floorInput = document.getElementById("bme-task-memory-floor");
  const filterSelect = document.getElementById("bme-task-memory-filter");
  const applyButton = document.getElementById("bme-task-memory-apply");
  if (searchInput && !searchInput._bmeBound) {
    const syncDraft = () => {
      _readTaskMemoryDraftFromControls();
    };
    searchInput.addEventListener("input", syncDraft);
    floorInput?.addEventListener("input", syncDraft);
    filterSelect?.addEventListener("change", syncDraft);
    applyButton?.addEventListener("click", () => _applyTaskMemorySearchDraft());
    searchInput._bmeBound = true;
  }

  return { listEl, detailEl };
}

function _refreshTaskMemoryBrowser() {
  const el = document.getElementById("bme-task-memory");
  if (!el) return;

  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph || !_canRenderGraphData(loadInfo)) {
    el.innerHTML = '<div class="bme-memory-detail-empty">Đồ thị chưa được tải</div>';
    return;
  }

  const shell = _ensureTaskMemoryBrowserShell(el);
  const listEl = shell?.listEl;
  if (!listEl) return;

  const currentQuery = String(taskMemorySearchApplied.query || "");
  const normalizedQuery = currentQuery.trim().toLowerCase();
  const currentFilter = taskMemorySearchApplied.filter || "all";
  const currentFloorQuery = String(taskMemorySearchApplied.floorQuery || "").trim();

  let nodes = Array.isArray(graph.nodes)
    ? graph.nodes.filter((node) => !node?.archived)
    : [];

  if (currentFilter !== "all") {
    nodes = nodes.filter((node) => _matchesMemoryFilter(node, currentFilter));
  }

  if (normalizedQuery) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const snippet = _getNodeSnippet(node).toLowerCase();
      const fieldsText = JSON.stringify(node?.fields || {}).toLowerCase();
      return (
        name.includes(normalizedQuery) ||
        snippet.includes(normalizedQuery) ||
        fieldsText.includes(normalizedQuery)
      );
    });
  }

  if (currentFloorQuery) {
    const floorFilter = _parseFloorFilter(currentFloorQuery);
    if (floorFilter) {
      nodes = nodes.filter((node) => _matchesFloorFilter(node, floorFilter));
    }
  }

  const sorted = nodes.slice().sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  if (!sorted.some((node) => node.id === currentSelectedMemoryNodeId)) {
    currentSelectedMemoryNodeId = sorted[0]?.id || "";
  }

  const listItems = sorted.map((node) => {
    const sel = node.id === currentSelectedMemoryNodeId ? "selected" : "";
    const preview = _getNodeSnippet(node);
    const scopeBadge = buildScopeBadgeText(node.scope);
    const metaText = _buildScopeMetaText(node);
    const displayName = getNodeDisplayName(node);
    return `
      <div class="bme-memory-node-item ${sel}" data-node-id="${_escHtml(node.id)}">
        <div class="bme-memory-node-item__header">
          <span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>
          <span class="bme-memory-node-item__imp">IMP: ${typeof node.importance === "number" ? node.importance.toFixed(1) : "—"}</span>
        </div>
        <div class="bme-memory-node-item__title">${_escHtml(displayName)}</div>
        <div class="bme-memory-node-item__preview">${_escHtml(preview)}</div>
        <div class="bme-memory-node-item__meta">
          <span>${_escHtml(scopeBadge)}</span>
          <span>SEQ: ${_formatMemoryInt(node.seqRange?.[1] ?? node.seq, 0)}</span>
        </div>
        ${metaText ? `<div class="bme-memory-node-item__meta">${_escHtml(metaText)}</div>` : ""}
      </div>`;
  }).join("");

  listEl.innerHTML =
    listItems ||
    '<div style="padding:16px;font-size:12px;color:var(--bme-on-surface-dim)">Không có nút</div>';

  _renderTaskMemoryDetailSelection(graph);
  _bindTaskMemoryListClick();
  return;

  el.innerHTML = `
    <div class="bme-memory-master-detail">
      <div class="bme-memory-list-panel">
        <div class="bme-memory-list-filters">
          <input type="text" class="bme-search-input" id="bme-task-memory-search" placeholder="Tìm kiếm nút ký ức..." value="${_escHtml(currentQuery)}" />
          <input type="text" class="bme-search-input bme-floor-input" id="bme-task-memory-floor" placeholder="Tầng (ví dụ 4, 3-10)" value="${_escHtml(currentFloorQuery)}" />
          <select class="bme-filter-select" id="bme-task-memory-filter">
            <option value="all"${currentFilter === "all" ? " selected" : ""}>Tất cả</option>
            <option value="scope:objective"${currentFilter === "scope:objective" ? " selected" : ""}>Khách quan</option>
            <option value="scope:characterPov"${currentFilter === "scope:characterPov" ? " selected" : ""}>POV nhân vật</option>
            <option value="scope:userPov"${currentFilter === "scope:userPov" ? " selected" : ""}>POV người dùng</option>
            <option value="pov_memory"${currentFilter === "pov_memory" ? " selected" : ""}>Ký ức chủ quan</option>
            <option value="event"${currentFilter === "event" ? " selected" : ""}>Sự kiện</option>
            <option value="location"${currentFilter === "location" ? " selected" : ""}>Địa điểm</option>
            <option value="thread"${currentFilter === "thread" ? " selected" : ""}>Manh mối</option>
            <option value="rule"${currentFilter === "rule" ? " selected" : ""}>Quy tắc</option>
          </select>
        </div>
        <div class="bme-memory-list-scroll" id="bme-task-memory-list">
          ${listItems || '<div style="padding:16px;font-size:12px;color:var(--bme-on-surface-dim)">Không có nút</div>'}
        </div>
      </div>
      <div class="bme-memory-detail-panel" id="bme-task-memory-detail"></div>
    </div>
  `;

  _renderTaskMemoryDetailSelection(graph);
  _bindTaskMemoryListClick();
}

function _bindTaskMemoryListClick() {
  const list = document.getElementById("bme-task-memory-list");
  if (!list || list._bmeBound) return;
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".bme-memory-node-item");
    if (!item) return;
    currentSelectedMemoryNodeId = item.dataset.nodeId || "";
    list.querySelectorAll(".bme-memory-node-item").forEach((n) => n.classList.toggle("selected", n.dataset.nodeId === currentSelectedMemoryNodeId));
    const graph = _getGraph?.();
    if (_isMobile()) {
      const node = (graph?.nodes || []).find((c) => c.id === currentSelectedMemoryNodeId) || null;
      if (node) _openMemoryPopup(node, graph);
    } else {
      _renderTaskMemoryDetailSelection(graph);
    }
  });
  list._bmeBound = true;
}

function _renderTaskMemoryDetailSelection(graph = _getGraph?.()) {
  const detailEl = document.getElementById("bme-task-memory-detail");
  if (!detailEl) return;

  const node = (graph?.nodes || []).find((candidate) => candidate.id === currentSelectedMemoryNodeId) || null;
  if (!node) {
    detailEl.innerHTML = '<div class="bme-memory-detail-empty"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>Chọn nút ở bên trái để xem chi tiết</div>';
    return;
  }

  _renderTaskMemoryDetailPanel(detailEl, node, graph);
}

function _renderTaskMemoryDetailPanel(detailEl, node, graph) {
  if (!detailEl) return;

  const edges = (graph?.edges || []).filter(
    (e) =>
      !e?.invalidAt &&
      !e?.expiredAt &&
      (e?.fromId === node.id || e?.toId === node.id),
  );
  const detailSummary = _getNodeSnippet(node);
  const scopeBadge = buildScopeBadgeText(node.scope);
  const displayName = getNodeDisplayName(node);
  const writeBlocked = _isGraphWriteBlocked();
  const disabledAttr = writeBlocked ? " disabled" : "";
  const badges = [
    node.type ? `<span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>` : "",
    scopeBadge ? `<span class="bme-memory-node-item__type type-default">${_escHtml(scopeBadge)}</span>` : "",
    node.archived ? '<span class="bme-memory-node-item__type type-default">ARCHIVED</span>' : "",
  ].filter(Boolean).join("");

  detailEl.innerHTML = `
    <div class="bme-memory-detail__header">
      <div class="bme-memory-detail__title">${_escHtml(displayName)}</div>
      <div class="bme-memory-detail__header-actions">
        <button class="bme-detail-action-btn" data-task-memory-action="save" type="button" title="Lưu thay đổi"${disabledAttr}>
          <i class="fa-solid fa-floppy-disk"></i>
        </button>
        <button class="bme-detail-action-btn bme-detail-action-danger" data-task-memory-action="delete" type="button" title="Xóa nút"${disabledAttr}>
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
    <div class="bme-memory-detail__badges">${badges}</div>
    <div class="bme-memory-detail__desc">${_escHtml(detailSummary || "Không có trường bổ sung")}</div>
    <div class="bme-memory-detail__stats">
      <span><i class="fa-solid fa-link" style="margin-right:4px;opacity:.5"></i>${edges.length} kết nối</span>
      <span><i class="fa-solid fa-eye" style="margin-right:4px;opacity:.5"></i>Lượt truy cập ${_formatMemoryInt(node.accessCount, 0)}</span>
    </div>
    <div id="bme-task-memory-editor-body"></div>
  `;

  const editorBody = detailEl.querySelector("#bme-task-memory-editor-body");
  if (editorBody) {
    editorBody.replaceChildren(
      _buildNodeDetailEditorFragment(node, { idPrefix: "bme-task-detail" }),
    );
  }

  detailEl
    .querySelector('[data-task-memory-action="save"]')
    ?.addEventListener("click", () => _saveTaskMemoryDetail());
  detailEl
    .querySelector('[data-task-memory-action="delete"]')
    ?.addEventListener("click", () => _deleteTaskMemoryDetail());
}

function _saveTaskMemoryDetail() {
  const popupBody = document.getElementById("bme-memory-popup-body");
  const popupOpen = document.getElementById("bme-memory-popup")?.classList.contains("open");
  const detailEl = popupOpen ? null : document.getElementById("bme-task-memory-detail");
  const bodyEl = popupOpen
    ? popupBody
    : detailEl?.querySelector("#bme-task-memory-editor-body");
  const nodeId = currentSelectedMemoryNodeId;
  if (!nodeId || !bodyEl) return;

  const idPrefix = popupOpen ? "bme-popup-detail" : "bme-task-detail";
  const collected = _collectNodeDetailEditorUpdates(bodyEl, { idPrefix });
  if (!collected.ok) {
    toastr.error(collected.errorMessage || "Lưu thất bại", "ST-BME");
    return;
  }

  _persistNodeDetailEdits(nodeId, collected.updates, {
    afterSuccess: () => {
      if (popupOpen) {
        const graph = _getGraph?.();
        const refreshedNode = (graph?.nodes || []).find((n) => n.id === nodeId);
        if (refreshedNode) _openMemoryPopup(refreshedNode, graph);
      }
    },
  });
}

function _deleteTaskMemoryDetail() {
  const nodeId = currentSelectedMemoryNodeId;
  if (!nodeId) return;

  _deleteGraphNodeById(nodeId, {
    afterSuccess: () => {
      currentSelectedMemoryNodeId = "";
      _closeMemoryPopup();
    },
  });
}

function _openMemoryPopup(node, graph) {
  const popup = document.getElementById("bme-memory-popup");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  const titleEl = document.getElementById("bme-memory-popup-title");
  const badgesEl = document.getElementById("bme-memory-popup-badges");
  const bodyEl = document.getElementById("bme-memory-popup-body");
  if (!popup || !bodyEl) return;

  const displayName = getNodeDisplayName(node);
  const scopeBadge = buildScopeBadgeText(node.scope);
  const badges = [
    node.type ? `<span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>` : "",
    scopeBadge ? `<span class="bme-memory-node-item__type type-default">${_escHtml(scopeBadge)}</span>` : "",
    node.archived ? '<span class="bme-memory-node-item__type type-default">ARCHIVED</span>' : "",
  ].filter(Boolean).join("");

  if (titleEl) titleEl.textContent = displayName;
  if (badgesEl) badgesEl.innerHTML = badges;

  bodyEl.replaceChildren(
    _buildNodeDetailEditorFragment(node, { idPrefix: "bme-popup-detail" }),
  );

  scrim?.removeAttribute("hidden");
  popup.classList.add("open");
}

function _closeMemoryPopup() {
  const popup = document.getElementById("bme-memory-popup");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  popup?.classList.remove("open");
  scrim?.setAttribute("hidden", "");
}

function _bindMemoryPopup() {
  const closeBtn = document.getElementById("bme-memory-popup-close");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  const saveBtn = document.getElementById("bme-memory-popup-save");
  const deleteBtn = document.getElementById("bme-memory-popup-delete");

  closeBtn?.addEventListener("click", () => _closeMemoryPopup());
  scrim?.addEventListener("click", () => _closeMemoryPopup());
  saveBtn?.addEventListener("click", () => _saveTaskMemoryDetail());
  deleteBtn?.addEventListener("click", () => _deleteTaskMemoryDetail());
}

// ---------- Injection Preview ----------

function _refreshTaskInjectionPreview() {
  const el = document.getElementById("bme-task-injection");
  if (!el) return;

  const injectionText = String(_getLastInjection?.() || "").trim();
  if (!injectionText) {
    el.innerHTML = '<div class="bme-memory-detail-empty">Chưa có dữ liệu tiêm — sẽ hiển thị sau lần tiêm truy hồi đầu tiên.</div>';
    return;
  }

  const debug = _getRuntimeDebugSnapshot?.() || {};
  const rd = debug.runtimeDebug || {};
  const recallSnap = rd?.injections?.recall || {};
  const totalTokens = recallSnap.tokenCount || 0;
  const budgetTokens = recallSnap.budgetTokens || totalTokens || 1;
  const pct = totalTokens > 0 ? Math.min(100, Math.round((totalTokens / budgetTokens) * 100)) : 0;

  const wrapper = document.createDocumentFragment();

  if (totalTokens > 0) {
    const bar = document.createElement("div");
    bar.className = "bme-injection-token-bar";
    bar.innerHTML = `
      <span class="bme-injection-token-bar__label">${totalTokens} / ${budgetTokens} tok</span>
      <div class="bme-injection-token-bar__track">
        <div class="bme-injection-token-bar__fill" style="width:${pct}%"></div>
      </div>
      <span class="bme-injection-token-bar__breakdown">${pct}%</span>`;
    wrapper.appendChild(bar);
  }

  wrapper.appendChild(_buildInjectionPreviewNode(injectionText));
  el.replaceChildren(wrapper);
}

// ---------- Message Trace ----------

function _refreshTaskMessageTrace() {
  const el = document.getElementById("bme-task-trace");
  if (!el) return;

  const settings = _getSettings?.() || {};
  const state = _getMessageTraceWorkspaceState(settings);
  el.innerHTML = _renderMessageTraceWorkspace(state);
}

// ---------- Persistence Status ----------

function _refreshTaskPersistence() {
  const el = document.getElementById("bme-task-persistence");
  if (!el) return;

  const graph = _getGraph?.() || {};
  const ps = _getGraphPersistenceSnapshot();
  const rs = graph.runtimeState || {};

  const LOAD_STATE_LABELS = {
    "no-chat": "Không có chat",
    loading: "Đang tải",
    loaded: "Đã tải",
    blocked: "Đã chặn",
    error: "Lỗi",
  };

  const STORAGE_TIER_LABELS = {
    none: "Không",
    metadata: "Metadata",
    "metadata-full": "Metadata đầy đủ",
    indexeddb: "IndexedDB",
    opfs: "OPFS",
    "chat-state": "Sidecar chat",
    "luker-chat-state": "Lưu trữ chính của sidecar Luker",
    shadow: "Snapshot bóng",
  };
  const HOST_PROFILE_LABELS = {
    "generic-st": "ST chung",
    luker: "Luker",
  };
  const CACHE_MIRROR_LABELS = {
    idle: "Rảnh",
    none: "Không",
    queued: "Đang xếp hàng",
    saved: "Đã cập nhật",
    error: "Thất bại",
  };

  const loadStateLabel = LOAD_STATE_LABELS[ps.loadState] || ps.loadState || "Không rõ";
  const acceptedTierLabel =
    STORAGE_TIER_LABELS[ps.acceptedStorageTier || ps.storageTier] ||
    ps.acceptedStorageTier ||
    ps.storageTier ||
    "—";
  const primaryTierLabel =
    STORAGE_TIER_LABELS[ps.primaryStorageTier] || ps.primaryStorageTier || "—";
  const cacheTierLabel =
    STORAGE_TIER_LABELS[ps.cacheStorageTier] || ps.cacheStorageTier || "—";
  const hostProfileLabel =
    HOST_PROFILE_LABELS[ps.hostProfile] || ps.hostProfile || "Không rõ";
  const opfsLock = ps.opfsWriteLockState || null;
  const opfsLockLabel = opfsLock
    ? opfsLock.active
      ? `Đang hoạt động · queue ${Number(opfsLock.queueDepth || 0)}`
      : `Rảnh · queue ${Number(opfsLock.queueDepth || 0)}`
    : "—";
  const opfsCompactionState = String(ps.opfsCompactionState?.state || "").trim();
  const opfsCompactionLabel = opfsCompactionState || "—";
  const sidecarFormatLabel =
    ps.hostProfile === "luker"
      ? `v${Number(ps.lukerSidecarFormatVersion || 0) || 1}`
      : "—";
  const manifestRevisionLabel =
    ps.hostProfile === "luker" ? String(Number(ps.lukerManifestRevision || 0)) : "—";
  const journalStateLabel =
    ps.hostProfile === "luker"
      ? `${Number(ps.lukerJournalDepth || 0)} mục / ${Number(ps.lukerJournalBytes || 0)} B`
      : "—";
  const checkpointRevisionLabel =
    ps.hostProfile === "luker" ? String(Number(ps.lukerCheckpointRevision || 0)) : "—";
  const cacheLagLabel =
    ps.hostProfile === "luker" ? String(Number(ps.cacheLag || 0)) : "—";
  const verboseDebugLabel = globalThis.__stBmeVerboseDebug === true ? "Bật" : "Tắt";
  const projectionLabel =
    ps?.projectionState?.runtime?.status || ps?.projectionState?.persistent?.status || "—";
  const compactTargetLabel = (() => {
    const target = ps.chatStateTarget;
    if (!target || typeof target !== "object") return "Chưa liên kết";
    if (target.is_group === true) {
      return `Chat nhóm · ${String(target.id || "—")}`;
    }
    return `Chat nhân vật · ${String(target.file_name || "—")}`;
  })();
  const mirrorLabel =
    CACHE_MIRROR_LABELS[ps.cacheMirrorState] || ps.cacheMirrorState || "—";
  const acceptedSummaryLabel =
    ps.pendingPersist === true
      ? "Chờ xác nhận"
      : ps.persistMismatchReason
        ? "Bất thường nhất quán"
        : acceptedTierLabel !== "—" && acceptedTierLabel !== "Không"
          ? acceptedTierLabel
          : ps.shadowSnapshotUsed
            ? "Chỉ neo khôi phục"
            : "Chưa xác nhận";
  const healthLabel = ps.pendingPersist === true
    ? "Đang chờ xác nhận lưu bền chính thức"
    : ps.persistMismatchReason
      ? _formatPersistMismatchReason(ps.persistMismatchReason)
      : ps.blockedReason || (ps.loadState === "blocked" ? ps.reason : "") || "Bình thường";
  const localEngineLabel =
    ps.resolvedLocalStore
      ? String(ps.resolvedLocalStore).replace(":", " / ")
      : cacheTierLabel;
  const sidecarSummaryLabel =
    ps.hostProfile === "luker"
      ? `rev ${manifestRevisionLabel} · ${journalStateLabel}`
      : "—";
  const historyState = graph?.historyState || {};
  const summaryState = graph?.summaryState || {};
  const journalCount = Array.isArray(graph?.batchJournal) ? graph.batchJournal.length : 0;
  const summaryCount = Array.isArray(summaryState?.entries) ? summaryState.entries.length : 0;
  const activeSummaryCount = Array.isArray(summaryState?.activeEntryIds)
    ? summaryState.activeEntryIds.length
    : 0;
  const processedFloorLabel = Number.isFinite(Number(historyState?.lastProcessedAssistantFloor))
    ? String(Number(historyState.lastProcessedAssistantFloor))
    : "—";
  const extractionCountLabel = Number.isFinite(Number(historyState?.extractionCount))
    ? String(Number(historyState.extractionCount))
    : "0";
  const activeRegionLabel = String(
    historyState?.activeRegion ||
      historyState?.lastExtractedRegion ||
      "—",
  );
  const dirtyFromLabel = Number.isFinite(Number(historyState?.historyDirtyFrom))
    ? String(Number(historyState.historyDirtyFrom))
    : "Không";

  const summaryPills = [
    `Tải · ${loadStateLabel}`,
    `Host · ${hostProfileLabel}`,
    `Lưu trữ chính · ${primaryTierLabel}`,
    `Xác nhận · ${acceptedSummaryLabel}`,
  ];
  const renderRows = (rows = []) =>
    rows
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(
        ([key, value]) =>
          `<div class="bme-persist-kv__row"><span>${_escHtml(String(key))}</span><strong>${_escHtml(String(value))}</strong></div>`,
      )
      .join("");

  const primaryRows = [
    ["Trạng thái hiện tại", acceptedSummaryLabel],
    ["Trạng thái sức khỏe", healthLabel],
    ["Chat Target", compactTargetLabel],
    ["Durable chính", primaryTierLabel],
    ps.hostProfile === "luker"
      ? ["Luker Sidecar", sidecarSummaryLabel]
      : ["Engine cục bộ", localEngineLabel],
    ps.hostProfile === "luker"
      ? ["Bộ đệm cục bộ", `${cacheTierLabel} · ${mirrorLabel}`]
      : ["Neo khôi phục", ps.shadowSnapshotUsed ? "Snapshot bóng đã tiếp quản" : "Không"],
  ];

  const runtimeRows = [
    ["Nút đồ thị", String((graph.nodes || []).length)],
    ["Cạnh đồ thị", String((graph.edges || []).length)],
    ["Nhật ký lô", String(journalCount)],
    ["Số lần trích xuất", extractionCountLabel],
    ["Tầng đã xử lý", processedFloorLabel],
    ["Mục tóm tắt", `${summaryCount} (hoạt động ${activeSummaryCount}）`],
    ["Khu vực hiện tại", activeRegionLabel],
    ["Điểm bắt đầu vùng bẩn", dirtyFromLabel],
    ["Phiên bản chạy", String(rs.graphRevision ?? "—")],
  ];

  const diagnosticRows = [
    ["Hồ sơ host", hostProfileLabel],
    ["accepted by", ps.acceptedBy || "—"],
    ["Tầng chẩn đoán", STORAGE_TIER_LABELS[ps.persistDiagnosticTier] || ps.persistDiagnosticTier || "Không"],
    ["Dấu commit", ps.commitMarker ? "Có (neo chẩn đoán)" : "Không"],
    ["Số phiên bản", ps.revision ?? "—"],
    ["Định dạng cục bộ", `v${Number(ps.localStoreFormatVersion || 0) || 1}`],
    ["Di chuyển cục bộ", ps.localStoreMigrationState || "—"],
    ["Chế độ nhẹ", ps.lightweightHostMode ? "Bật" : "Tắt"],
    ["Verbose Debug", verboseDebugLabel],
    ["Luker Hook", ps.lastHookPhase || "—"],
    ["Projection", projectionLabel],
    ["Lý do rescan", ps.lastRequestRescanReason || "—"],
    ["Bỏ qua thay đổi", ps.lastIgnoredMutationEvent || "—"],
    ["Snapshot bóng", ps.shadowSnapshotUsed ? "Đã dùng" : "Chưa dùng"],
    ["Khóa ghi OPFS", opfsLockLabel],
    ["OPFS WAL", `${Number(ps.opfsWalDepth || 0)} mục / ${Number(ps.opfsPendingBytes || 0)} B`],
    ["Nén OPFS", opfsCompactionLabel],
    ["Định dạng đồng bộ từ xa", `v${Number(ps.remoteSyncFormatVersion || 0) || 1}`],
  ];
  if (ps.hostProfile === "luker") {
    diagnosticRows.splice(5, 0,
      ["Định dạng Sidecar", sidecarFormatLabel],
      ["Manifest rev", manifestRevisionLabel],
      ["Journal", journalStateLabel],
      ["Checkpoint rev", checkpointRevisionLabel],
      ["Bộ đệm bị trễ", cacheLagLabel],
    );
  }

  el.innerHTML = `
    <div class="bme-persist-grid">
      <div class="bme-persist-kv">
        <div style="font-size:12px;font-weight:700;color:var(--bme-on-surface);margin-bottom:10px"><i class="fa-solid fa-database" style="margin-right:6px;color:var(--bme-primary)"></i>Trạng thái lưu bền</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          ${summaryPills.map((pill) => `<span class="bme-task-pill">${_escHtml(pill)}</span>`).join("")}
        </div>
        <div class="bme-config-help" style="margin-bottom:12px">
          Ở đây chỉ giữ lại thông tin lưu bền hay dùng nhất hằng ngày. Các trường thiên về kỹ thuật hơn đã được đẩy xuống phần chi tiết chẩn đoán để tránh mất cân bằng với tổng quan chạy ở bên phải.
        </div>
        ${renderRows(primaryRows)}
        <details style="margin-top:14px;border-top:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.10));padding-top:12px">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--bme-on-surface);list-style:none">
            <i class="fa-solid fa-stethoscope" style="margin-right:6px;color:var(--bme-primary)"></i>Xem chi tiết chẩn đoán
          </summary>
          <div style="margin-top:12px">
            ${renderRows(diagnosticRows)}
          </div>
        </details>
      </div>
      <div class="bme-persist-kv">
        <div style="font-size:12px;font-weight:700;color:var(--bme-on-surface);margin-bottom:10px"><i class="fa-solid fa-chart-bar" style="margin-right:6px;color:var(--bme-primary)"></i>Tổng quan chạy</div>
        <div class="bme-config-help" style="margin-bottom:12px">
          Bên phải chuyên hiển thị quy mô đồ thị hiện tại, tiến độ xử lý và tiền tuyến trạng thái chạy để giảm việc phần “Trạng thái lưu bền” bên trái phải gánh quá nhiều trách nhiệm vận hành.
        </div>
        ${renderRows(runtimeRows)}
      </div>
    </div>
  `;
}

// ==================== Chuyển chế độ xem đồ thị ====================

function _switchGraphView(view) {
  currentGraphView = view || "graph";
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.graphView === currentGraphView);
  });

  const canvas = document.getElementById("bme-graph-canvas");
  const legend = document.getElementById("bme-graph-legend");
  const statusbar = panelEl?.querySelector(".bme-graph-statusbar");
  const nodeDetail = document.getElementById("bme-node-detail");
  const cogWorkspace = document.getElementById("bme-cognition-workspace");
  const summaryWorkspace = document.getElementById("bme-summary-workspace");
  const graphControls = panelEl?.querySelector(".bme-graph-controls");

  const isGraph = currentGraphView === "graph";
  const isCognition = currentGraphView === "cognition";
  const isSummary = currentGraphView === "summary";
  if (canvas) canvas.style.display = isGraph ? "" : "none";
  if (legend) legend.style.display = isGraph ? "" : "none";
  if (statusbar) statusbar.style.display = isGraph ? "" : "none";
  if (nodeDetail) nodeDetail.style.display = isGraph ? "" : "none";
  if (!isGraph) {
    nodeDetail?.classList.remove("open");
  }
  if (graphControls) graphControls.style.display = isGraph ? "" : "none";
  if (cogWorkspace) cogWorkspace.hidden = !isCognition;
  if (summaryWorkspace) summaryWorkspace.hidden = !isSummary;
  if (cogWorkspace) cogWorkspace.style.display = isCognition ? "" : "none";
  if (summaryWorkspace) summaryWorkspace.style.display = isSummary ? "" : "none";

  _refreshGraph({ force: true });
}

// ==================== Tab đồ thị di động ====================

function _switchMobileGraphSubView(view) {
  currentMobileGraphView = view || "graph";
  const pane = document.getElementById("bme-pane-graph");
  if (!pane) return;

  pane.querySelectorAll(".bme-graph-subtab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mobileGraphView === currentMobileGraphView);
  });
  pane.querySelectorAll(".bme-mobile-graph-pane").forEach((p) => {
    p.classList.toggle("active", p.dataset.mobileGraphView === currentMobileGraphView);
  });

  if (currentMobileGraphView !== "graph") {
    _closeNodeDetailUi();
  }

  _refreshMobileGraphTab();
}

function _refreshMobileGraphTab() {
  _refreshGraph({ force: true });
}

function _buildMobileLegend() {
  const legend = document.getElementById("bme-mobile-graph-legend");
  if (!legend) return;
  const desktopLegend = document.getElementById("bme-graph-legend");
  if (desktopLegend) {
    legend.innerHTML = desktopLegend.innerHTML;
  }
}

function _refreshMobileCognitionFull() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  _renderCogStatusStrip(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-status-strip"));
  _renderCogOwnerList(graph, canRender, document.getElementById("bme-mobile-cog-owner-list"));
  _renderCogOwnerDetail(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-owner-detail"));
  _renderCogSpaceTools(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-space-tools"));
  _renderCogMonitorMini(document.getElementById("bme-mobile-cog-monitor-mini"));
}

function _refreshMobileSummaryFull() {
  _refreshSummaryWorkspace(document.getElementById("bme-mobile-summary-full"));
}

function _ownerAvatarHsl(name) {
  let hash = 0;
  const str = String(name || "");
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function _normalizeOwnerUiType(ownerType = "") {
  const normalized = String(ownerType || "").trim();
  if (normalized === "user") return "user";
  if (normalized === "character") return "character";
  return "";
}

function _inferOwnerTypeFromKey(ownerKey = "") {
  const normalizedOwnerKey = String(ownerKey || "").trim().toLowerCase();
  if (normalizedOwnerKey.startsWith("user:")) return "user";
  if (normalizedOwnerKey.startsWith("character:")) return "character";
  return "";
}

function _getOwnerTypeDisplayLabel(ownerType = "") {
  const normalizedType = _normalizeOwnerUiType(ownerType);
  if (normalizedType === "user") return "Người dùng";
  if (normalizedType === "character") return "Nhân vật";
  return "Owner";
}

function _buildOwnerCollisionIndex(owners = []) {
  const collisionIndex = new Map();
  for (const owner of Array.isArray(owners) ? owners : []) {
    const baseName =
      String(owner?.ownerName || owner?.ownerKey || "Nhân vật chưa đặt tên").trim() ||
      "Nhân vật chưa đặt tên";
    const nameKey = baseName.toLocaleLowerCase("zh-Hans-CN");
    const ownerType = _normalizeOwnerUiType(owner?.ownerType) || "unknown";
    const entry = collisionIndex.get(nameKey) || {
      count: 0,
      typeCounts: new Map(),
    };
    entry.count += 1;
    entry.typeCounts.set(ownerType, (entry.typeCounts.get(ownerType) || 0) + 1);
    collisionIndex.set(nameKey, entry);
  }
  return collisionIndex;
}

function _shortOwnerNodeId(owner = {}) {
  const nodeId = String(owner?.nodeId || "").trim();
  if (!nodeId) return "";
  return nodeId.length > 6 ? nodeId.slice(0, 6) : nodeId;
}

function _getOwnerDisplayInfo(owner = {}, collisionIndex = null) {
  const baseName =
    String(owner?.ownerName || owner?.ownerKey || "Nhân vật chưa đặt tên").trim() ||
    "Nhân vật chưa đặt tên";
  const ownerKey = String(owner?.ownerKey || "").trim();
  const ownerType =
    _normalizeOwnerUiType(owner?.ownerType) || _inferOwnerTypeFromKey(ownerKey);
  const typeLabel = _getOwnerTypeDisplayLabel(ownerType);
  const collisionInfo =
    collisionIndex instanceof Map
      ? collisionIndex.get(baseName.toLocaleLowerCase("zh-Hans-CN")) || null
      : null;
  const typeCounts =
    collisionInfo?.typeCounts instanceof Map ? collisionInfo.typeCounts : new Map();
  const totalCount = Number(collisionInfo?.count || 0);
  const sameTypeCount = Number(typeCounts.get(ownerType || "unknown") || 0);
  const hasCrossTypeCollision = totalCount > 1 && typeCounts.size > 1;
  const shortNodeId = ownerType === "character" ? _shortOwnerNodeId(owner) : "";

  let title = baseName;
  if (hasCrossTypeCollision) {
    title = `${baseName}（${typeLabel}）`;
  } else if (sameTypeCount > 1) {
    title =
      ownerType === "character" && shortNodeId
        ? `${baseName}（${typeLabel} ${shortNodeId}）`
        : `${baseName}（${typeLabel}）`;
  }

  const subtitleParts = [typeLabel];
  if (ownerType === "character" && shortNodeId) {
    subtitleParts.push(`#${shortNodeId}`);
  }

  return {
    title,
    typeLabel,
    subtitle: subtitleParts.join(" · "),
    avatarText: baseName.charAt(0) || "?",
    avatarSeed: ownerKey || `${ownerType}:${baseName}`,
    tooltip: [title, ownerKey && ownerKey !== title ? ownerKey : ""]
      .filter(Boolean)
      .join(" · "),
  };
}

// ==================== Không gian chế độ nhận thức ====================

function _refreshCognitionWorkspace() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  _renderCogStatusStrip(graph, loadInfo, canRender);
  _renderCogOwnerList(graph, canRender);
  _renderCogOwnerDetail(graph, loadInfo, canRender);
  _renderCogSpaceTools(graph, loadInfo, canRender);
  _renderCogMonitorMini();
}

function _renderCogStatusStrip(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-status-strip");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = `<div class="bme-cog-status-card" style="grid-column:1/-1"><div class="bme-cog-status-card__value">${_escHtml(_getGraphLoadLabel(loadInfo))}</div></div>`;
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const timelineState = graph?.timelineState || {};
  const { owners, activeOwnerKey, activeOwner, activeOwnerLabels } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${historyState.activeRegionSource ? ` · ${historyState.activeRegionSource}` : ""}`
    : "—";
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const activeStoryTimeMeta = activeStoryTimeLabel
    ? `${activeStoryTimeLabel}${historyState.activeStoryTimeSource ? ` · ${historyState.activeStoryTimeSource}` : ""}`
    : "—";
  const recentStorySegments = Array.isArray(timelineState?.recentSegmentIds)
    ? timelineState.recentSegmentIds
        .map((segmentId) =>
          timelineState.segments?.find((segment) => segment.id === segmentId)?.label || "",
        )
        .filter(Boolean)
        .slice(0, 3)
    : [];

  el.innerHTML = `
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-user"></i> Neo cảnh hiện tại</div>
      <div class="bme-cog-status-card__value">${_escHtml(
        activeOwnerLabels.length > 0
          ? activeOwnerLabels.join(" / ")
          : activeOwner
            ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
            : activeOwnerKey || "—",
      )}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-location-dot"></i> Khu vực hiện tại</div>
      <div class="bme-cog-status-card__value">${_escHtml(activeRegionLabel)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-diagram-project"></i> Khu vực kề</div>
      <div class="bme-cog-status-card__value">${_escHtml(adjacentRegions.length > 0 ? adjacentRegions.join(" / ") : "—")}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-users"></i> Số nhân vật nhận thức</div>
      <div class="bme-cog-status-card__value">${owners.length}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-clock"></i> Thời gian cốt truyện hiện tại</div>
      <div class="bme-cog-status-card__value">${_escHtml(activeStoryTimeMeta)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-timeline"></i> Phân đoạn thời gian gần nhất</div>
      <div class="bme-cog-status-card__value">${_escHtml(recentStorySegments.length ? recentStorySegments.join(" / ") : "—")}</div>
    </div>
  `;
}

function _renderCogOwnerList(graph, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-owner-list");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { owners, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">Tạm thời chưa có nhân vật nhận thức</div>`;
    return;
  }

  el.innerHTML = owners
    .map((owner) => {
      const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
      const bgColor = _ownerAvatarHsl(displayInfo.avatarSeed);
      const selected = owner.ownerKey === currentCognitionOwnerKey ? "is-selected" : "";
      const anchor =
        owner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(owner.ownerKey)
          ? "is-active-anchor"
          : "";
      return `
        <div class="bme-cog-owner-card ${selected} ${anchor}"
             data-owner-key="${_escHtml(String(owner.ownerKey || ""))}"
             role="button" tabindex="0"
             title="${_escHtml(displayInfo.tooltip)}">
          <div class="bme-cog-avatar" style="background:${bgColor}">${_escHtml(displayInfo.avatarText)}</div>
          <div class="bme-cog-owner-card__info">
            <div class="bme-cog-owner-card__name-row">
              <div class="bme-cog-owner-card__name">${_escHtml(displayInfo.title)}</div>
              <span class="bme-cog-owner-card__badge">${_escHtml(displayInfo.typeLabel)}</span>
            </div>
            <div class="bme-cog-owner-card__stats">Đã biết ${Number(owner.knownCount || 0)} · Hiểu sai ${Number(owner.mistakenCount || 0)} · Ẩn ${Number(owner.manualHiddenCount || 0)}</div>
          </div>
        </div>`;
    })
    .join("");
}

function _renderCogOwnerDetail(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-owner-detail");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { selectedOwner, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(
    _getCognitionOwnerCollection(graph),
  );

  if (!selectedOwner) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">Hãy chọn một nhân vật ở phía trên để xem chi tiết, hoặc chờ trích xuất tạo dữ liệu nhận thức.</div>`;
    return;
  }

  const ownerState = graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
    aliases: selectedOwner.aliases || [],
    visibilityScores: {},
    manualKnownNodeIds: [],
    manualHiddenNodeIds: [],
    mistakenNodeIds: [],
    knownNodeIds: [],
    updatedAt: 0,
  };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({ nodeId: String(nodeId || ""), score: Number(score || 0) }))
    .filter((e) => e.nodeId)
    .sort((a, b) => b.score - a.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((e) => e.score >= 0.68).map((e) => e.nodeId),
    { limit: 6 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])],
    { limit: 6 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "known"
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "hidden"
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "mistaken"
          : "none"
    : "";
  const stateLabels = { known: "Cưỡng chế đã biết", hidden: "Cưỡng chế ẩn", mistaken: "hiểu sai", none: "Chưa bao phủ" };
  const selectedNodeStateLabel = stateLabels[selectedNodeState] || "Chưa chọn nút";
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const suppressedCount = new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size;
  const disabledAttr = !selectedNode || writeBlocked ? "disabled" : "";
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);

  const visChips = strongVisibleNames.length
    ? strongVisibleNames.map((n) => `<span class="bme-cog-chip is-visible">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">Chưa có</span>';
  const supChips = suppressedNames.length
    ? suppressedNames.map((n) => `<span class="bme-cog-chip is-suppressed">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">Chưa có</span>';

  el.innerHTML = `
    <div class="bme-cog-detail-header">
      <div class="bme-cog-detail-title-wrap">
        <div class="bme-cog-detail-name" title="${_escHtml(displayInfo.tooltip)}">${_escHtml(displayInfo.title)}</div>
        <div class="bme-cog-detail-meta">${_escHtml(
          [displayInfo.subtitle, selectedOwner.ownerKey || ""].filter(Boolean).join(" · "),
        )}</div>
      </div>
      ${
        selectedOwner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(selectedOwner.ownerKey)
          ? '<span class="bme-cog-detail-badge">Neo cảnh hiện tại</span>'
          : ""
      }
    </div>

    <div class="bme-cog-metrics">
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-known"></span> Neo đã biết</div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.knownCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-mistaken"></span> Nút hiểu sai</div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.mistakenCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-visible"></span> Hiển thị mạnh</div>
        <div class="bme-cog-metric__value">${strongVisibleNames.length}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-suppressed"></span> Bị áp chế</div>
        <div class="bme-cog-metric__value">${suppressedCount}</div>
      </div>
    </div>

    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">Hiển thị mạnhnút · ACTIVE VISIBILITY</div>
      <div class="bme-cog-chip-wrap">${visChips}</div>
    </div>
    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">Bị áp chếnút · SUPPRESSED</div>
      <div class="bme-cog-chip-wrap">${supChips}</div>
    </div>

    <div class="bme-cog-override-section">
      <div class="bme-cog-override-title">Ghi đè thủ công lên nút đang chọn</div>
      <div class="bme-cog-override-status">${
        selectedNode
          ? `Nút hiện tại: ${_escHtml(selectedNodeLabel)} · <span class="bme-cog-status-pill is-${selectedNodeState}">${_escHtml(selectedNodeStateLabel)}</span>`
          : "Hãy chọn một nút trước trong đồ thị thời gian thực hoặc danh sách ký ức."
      }</div>
      <div class="bme-cog-override-actions">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" data-bme-cognition-node-action="known" ${disabledAttr}>Cưỡng chế đã biết</button>
        <button class="bme-cog-btn bme-cog-btn--hidden" type="button" data-bme-cognition-node-action="hidden" ${disabledAttr}>Cưỡng chế ẩn</button>
        <button class="bme-cog-btn bme-cog-btn--mistaken" type="button" data-bme-cognition-node-action="mistaken" ${disabledAttr}>Đánh dấu hiểu sai</button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" data-bme-cognition-node-action="clear" ${disabledAttr}>Xóa ghi đè</button>
      </div>
    </div>
  `;
}

function _renderCogSpaceTools(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-space-tools");
  if (!el) return;

  if (!canRender) { el.innerHTML = ""; return; }

  const regionState = graph?.regionState || {};
  const historyState = graph?.historyState || {};
  const timelineState = graph?.timelineState || {};
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent : [];
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const disabledAttr = writeBlocked ? "disabled" : "";
  const manualStorySegmentId = String(timelineState.manualActiveSegmentId || "").trim();

  el.innerHTML = `
    <div class="bme-cog-space-row">
      <label>Khu vực hiện tại thủ công</label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-region"
             placeholder="đầu vàokhu vựcTên..." value="${_escHtml(regionState.manualActiveRegion || activeRegion || "")}" ${disabledAttr} />
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-region-apply" ${disabledAttr}>
          <i class="fa-solid fa-location-dot"></i> Đặt làm khu vực hiện tại
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-region-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> Khôi phụcTự động
        </button>
      </div>
    </div>
    <div class="bme-cog-space-row">
      <label>Khu vực kề của khu vực hiện tại</label>
      <input class="bme-config-input" type="text" id="bme-cog-adjacency-input"
             placeholder="Ví dụ: Nội đình, Cảng, Vườn hoa" value="${_escHtml(adjacentRegions.join(", "))}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">Dùng dấu "," để phân tách nhiều khu vực. Sau khi lưu sẽ cập nhật quan hệ kề của khu vực đó.</div>
      <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-adjacency-save" ${disabledAttr}>
        <i class="fa-solid fa-diagram-project"></i> Lưu khu vực kề hiện tại
      </button>
    </div>
    <div class="bme-cog-space-row">
      <label>Thời gian cốt truyện hiện tại thủ công</label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-story-time"
             placeholder="Ví dụ: Sáng sớm ngày thứ hai / Sau đêm qua / Tuổi thơ trong ký ức" value="${_escHtml(manualStorySegmentId ? activeStoryTimeLabel : activeStoryTimeLabel || "")}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">Để trống nghĩa là quay về cơ chế tự động; tại đây chỉ duy trì thời gian cốt truyện hiện tại, không ghi đè mọi nút.</div>
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-story-time-apply" ${disabledAttr}>
          <i class="fa-solid fa-clock"></i> Đặt làm thời gian cốt truyện hiện tại
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-story-time-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> Khôi phụcTự động
        </button>
      </div>
    </div>
  `;
}

function _renderCogMonitorMini(targetEl) {
  const el = targetEl || document.getElementById("bme-cog-monitor-mini");
  if (!el) return;

  const settings = _getSettings?.() || {};
  if (settings.enableAiMonitor !== true) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">Giám sát tác vụ đã tắt</div>`;
    return;
  }

  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const timeline = Array.isArray(runtimeDebug?.runtimeDebug?.taskTimeline)
    ? runtimeDebug.runtimeDebug.taskTimeline : [];

  if (!timeline.length) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">Tạm thời chưa có dòng thời gian tác vụ</div>`;
    return;
  }

  el.innerHTML = timeline
    .slice(-8)
    .reverse()
    .map((entry) => {
      const status = String(entry?.status || "").toLowerCase();
      const statusClass = status.includes("error") || status.includes("fail") ? "is-error"
        : status.includes("run") ? "is-running" : "is-success";
      const taskType = String(entry?.taskType || "unknown");
      const route =
        _getMonitorRouteLabel(entry?.route) ||
        _getMonitorRouteLabel(entry?.llmConfigSourceLabel) ||
        String(entry?.model || "").trim();
      const durationMs = Number(entry?.durationMs);
      const durationText = Number.isFinite(durationMs) && durationMs > 0
        ? durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`
        : "—";
      return `
        <div class="bme-cog-monitor-entry ${statusClass}">
          <span class="bme-cog-monitor-badge">${_escHtml(_getMonitorTaskTypeLabel(taskType))}</span>
          <span class="bme-cog-monitor-info">${_escHtml(route || _getMonitorStatusLabel(entry?.status) || "—")}</span>
          <span class="bme-cog-monitor-duration">${_escHtml(durationText)}</span>
        </div>`;
    })
    .join("");
}


function _formatSummaryEntryCard(entry = {}) {
  const messageRange = Array.isArray(entry?.dialogueRange)
    ? entry.dialogueRange
    : Array.isArray(entry?.messageRange)
      ? entry.messageRange
      : ["?", "?"];
  const extractionRange = Array.isArray(entry?.extractionRange)
    ? entry.extractionRange
    : ["?", "?"];
  const spanLabel = _describeStoryTimeSpanDisplay(entry?.storyTimeSpan);
  const meta = [
    `L${Math.max(0, Number(entry?.level || 0))}`,
    String(entry?.kind || "small"),
    `Trích xuất ${extractionRange[0]} ~ ${extractionRange[1]}`,
    `Tầng ${messageRange[0]} ~ ${messageRange[1]}`,
  ].join(" · ");
  const hintLine = [
    Array.isArray(entry?.regionHints) && entry.regionHints.length
      ? `Khu vực: ${entry.regionHints.join(" / ")}`
      : "",
    Array.isArray(entry?.ownerHints) && entry.ownerHints.length
      ? `Nhân vật: ${entry.ownerHints.join(" / ")}`
      : "",
    spanLabel ? `Thời gian: ${spanLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <div class="bme-cog-monitor-entry is-success" style="border-left-color:var(--bme-primary)">
      <span class="bme-cog-monitor-badge">${_escHtml(`L${Math.max(0, Number(entry?.level || 0))}`)}</span>
      <span class="bme-cog-monitor-info">${_escHtml(meta)}</span>
      <span class="bme-cog-monitor-duration">${_escHtml(String(entry?.kind || ""))}</span>
      <div class="bme-ai-monitor-entry__summary" style="grid-column:1/-1;margin-top:6px">
        ${_escHtml(String(entry?.text || ""))}
      </div>
      ${
        hintLine
          ? `<div class="bme-config-help" style="grid-column:1/-1;margin-top:4px">${_escHtml(hintLine)}</div>`
          : ""
      }
    </div>
  `;
}

function _refreshSummaryWorkspace(targetEl) {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  const workspace = targetEl || document.getElementById("bme-summary-workspace");
  if (!workspace) return;

  if (!graph || !_canRenderGraphData(loadInfo)) {
    workspace.innerHTML = `
      <div class="bme-cog-monitor-empty">${_escHtml(_getGraphLoadLabel(loadInfo))}</div>
    `;
    return;
  }

  const activeEntries = getActiveSummaryEntries(graph);
  const foldedEntries = getSummaryEntriesByStatus(graph, "folded")
    .sort(compareSummaryEntriesForDisplay)
    .slice(-12)
    .reverse();
  const summaryState = graph?.summaryState || {};
  const historyState = graph?.historyState || {};
  const debugText = [
    `Số lần trích xuất đã được tóm tắt gần nhất: ${Number(summaryState.lastSummarizedExtractionCount || 0)}`,
    `Tầng assistant đã được tóm tắt gần nhất: ${Number(summaryState.lastSummarizedAssistantFloor || -1)}`,
    `extractionCount hiện tại: ${Number(historyState.extractionCount || 0)}`,
  ].join(" · ");

  workspace.innerHTML = `
    <div class="bme-cog-status-strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">Tiền tuyến hoạt động</div>
        <div class="bme-cog-status-card__value">${activeEntries.length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">Lịch sử gộp</div>
        <div class="bme-cog-status-card__value">${getSummaryEntriesByStatus(graph, "folded").length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">summaryState</div>
        <div class="bme-cog-status-card__value">${summaryState.enabled === false ? "off" : "on"}</div>
      </div>
    </div>

    <div class="bme-task-toolbar-row" style="margin-bottom:12px">
      <div class="bme-task-toolbar-inline">
        <button class="bme-config-secondary-btn" id="bme-summary-generate" type="button">Tạo tóm tắt ngắn ngay</button>
        <button class="bme-config-secondary-btn" id="bme-summary-rollup" type="button">Thực hiện gộp ngay</button>
        <button class="bme-config-secondary-btn" id="bme-summary-rebuild" type="button">Xây lại trạng thái tóm tắt</button>
      </div>
    </div>

    <div class="bme-config-help" style="margin-bottom:12px">${_escHtml(debugText)}</div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-layer-group"></i> Tiền tuyến tóm tắt hoạt động</div>
    <div class="bme-cog-monitor-mini" style="margin-bottom:14px">
      ${activeEntries.length > 0
        ? activeEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">Hiện chưa có tiền tuyến tóm tắt hoạt động.</div>'}
    </div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-box-archive"></i> Lịch sử gộp</div>
    <div class="bme-cog-monitor-mini">
      ${foldedEntries.length > 0
        ? foldedEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">Hiện chưa có lịch sử gộp.</div>'}
    </div>
  `;
}

function _openFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function _closeFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}



function _switchConfigSection(sectionId) {
  currentConfigSectionId = sectionId || "toggles";
  _syncConfigSectionState();
  if (currentConfigSectionId === "prompts") {
    _refreshTaskProfileWorkspace();
  } else if (currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
  }
}

function _syncConfigSectionState() {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.dataset.configSection === currentConfigSectionId,
    );
  });
  panelEl.querySelectorAll(".bme-config-section").forEach((section) => {
    section.classList.toggle(
      "active",
      section.dataset.configSection === currentConfigSectionId,
    );
  });
}

// ==================== Tổng quan Tab ====================

function _refreshDashboard() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  if (!_canRenderGraphData(loadInfo) && loadInfo.loadState !== "empty-confirmed") {
    _setText("bme-stat-nodes", "—");
    _setText("bme-stat-edges", "—");
    _setText("bme-stat-archived", "—");
    _setText("bme-stat-frag", "—");
    _setText("bme-status-chat-id", loadInfo.chatId || "—");
    _setText("bme-status-history", _getGraphLoadLabel(loadInfo));
    _setText("bme-status-vector", "Đang chờ metadata đồ thị chat tải xong");
    _setText("bme-status-recovery", "Đang chờ metadata đồ thị chat tải xong");
    _setText("bme-status-last-extract", "Đang chờ metadata đồ thị chat tải xong");
    _setText("bme-status-last-persist", "Đang chờ metadata đồ thị chat tải xong");
    _setText("bme-status-last-vector", "Đang chờ metadata đồ thị chat tải xong");
    _setText("bme-status-last-recall", "Đang chờ metadata đồ thị chat tải xong");
    _refreshPersistenceRepairUi(loadInfo, null);
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-extract"),
      _getGraphLoadLabel(loadInfo),
    );
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-recall"),
      _getGraphLoadLabel(loadInfo),
    );
    _refreshCognitionDashboard(graph, loadInfo);
    _refreshAiMonitorDashboard();
    return;
  }

  const activeNodes = graph.nodes.filter((node) => !node.archived);
  const archivedCount = graph.nodes.filter((node) => node.archived).length;
  const totalNodes = graph.nodes.length;
  const fragRate =
    totalNodes > 0 ? Math.round((archivedCount / totalNodes) * 100) : 0;

  _setText("bme-stat-nodes", activeNodes.length);
  _setText("bme-stat-edges", graph.edges.length);
  _setText("bme-stat-archived", archivedCount);
  _setText("bme-stat-frag", `${fragRate}%`);

  const chatId = loadInfo.chatId || graph?.historyState?.chatId || "—";
  const lastProcessed = graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  const vectorStats = getVectorIndexStats(graph);
  const vectorMode = graph?.vectorIndexState?.mode || "—";
  const vectorSource = graph?.vectorIndexState?.source || "—";
  const recovery = graph?.historyState?.lastRecoveryResult;
  const extractionStatus = _getLastExtractionStatus?.() || {};
  const lastBatchStatus = _getLatestBatchStatusSnapshot();
  const vectorStatus = _getLastVectorStatus?.() || {};
  const recallStatus = _getLastRecallStatus?.() || {};
  const historyPrefix =
    loadInfo.loadState === "shadow-restored"
      ? "Khôi phục tạm · "
      : loadInfo.loadState === "blocked" && loadInfo.shadowSnapshotUsed
        ? "Chế độ bảo vệ · "
        : "";

  _setText("bme-status-chat-id", chatId);
  _setText(
    "bme-status-history",
    `${historyPrefix}${_formatDashboardHistoryMeta(graph, loadInfo, lastBatchStatus)}`,
  );
  _setText(
    "bme-status-vector",
    `${vectorMode}/${vectorSource} · total ${vectorStats.total} · indexed ${vectorStats.indexed} · stale ${vectorStats.stale} · pending ${vectorStats.pending}`,
  );
  _setText(
    "bme-status-recovery",
    recovery
      ? [
          recovery.status || "—",
          recovery.path ? `path ${recovery.path}` : "",
          recovery.detectionSource ? `src ${recovery.detectionSource}` : "",
          recovery.fromFloor != null ? `from ${recovery.fromFloor}` : "",
          recovery.affectedBatchCount != null
            ? `affected ${recovery.affectedBatchCount}`
            : "",
          recovery.replayedBatchCount != null
            ? `replayed ${recovery.replayedBatchCount}`
            : "",
          recovery.reason || "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "Tạm thời chưa có bản ghi khôi phục",
  );
  _setText("bme-status-last-extract", extractionStatus.meta || "Chưa thực hiện trích xuất");
  _setText(
    "bme-status-last-persist",
    _formatDashboardPersistMeta(loadInfo, lastBatchStatus),
  );
  _refreshPersistenceRepairUi(loadInfo, lastBatchStatus);
  _setText("bme-status-last-vector", vectorStatus.meta || "Chưa thực hiện tác vụ vector");
  _setText("bme-status-last-recall", recallStatus.meta || "Chưa thực hiện truy hồi");

  _refreshCognitionDashboard(graph);
  _refreshAiMonitorDashboard();
  _renderRecentList("bme-recent-extract", _getLastExtract?.() || []);
  _renderRecentList("bme-recent-recall", _getLastRecall?.() || []);
}

function _renderMiniRecentList(elementId, entries = [], emptyText = "Tạm thời chưa có dữ liệu") {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!Array.isArray(entries) || entries.length === 0) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = String(entry || "");
    listEl.appendChild(li);
  }
}

function _setInputValueIfIdle(elementId, value = "") {
  const input = document.getElementById(elementId);
  if (!input) return;
  if (document.activeElement === input) return;
  input.value = String(value || "");
}

function _getSelectedGraphNode(graph = _getGraph?.()) {
  const detailNodeId = String(
    document.getElementById("bme-node-detail")?.dataset?.editNodeId ||
      document.getElementById("bme-mobile-node-detail")?.dataset?.editNodeId ||
      "",
  ).trim();
  const rendererNodeId = String(
    _getActiveGraphRenderer()?.selectedNode?.id || "",
  ).trim();
  const nodeId = detailNodeId || rendererNodeId;
  if (!nodeId || !Array.isArray(graph?.nodes)) return null;
  return graph.nodes.find((node) => String(node?.id || "") === nodeId) || null;
}

function _getCognitionOwnerCollection(graph) {
  return typeof listKnowledgeOwners === "function" ? listKnowledgeOwners(graph) : [];
}

function _getLatestRecallOwnerInfo(graph) {
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const recallInjection =
    runtimeDebug?.runtimeDebug?.injections?.recall || {};
  const retrievalMeta = recallInjection?.retrievalMeta || {};
  const owners = _getCognitionOwnerCollection(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const ownerCandidates = Array.isArray(retrievalMeta.sceneOwnerCandidates)
    ? retrievalMeta.sceneOwnerCandidates
    : [];
  const ownerKeys = Array.isArray(retrievalMeta.activeRecallOwnerKeys)
    ? retrievalMeta.activeRecallOwnerKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const fallbackOwnerKey = String(graph?.historyState?.activeRecallOwnerKey || "").trim();
  const normalizedOwnerKeys = ownerKeys.length > 0
    ? [...new Set(ownerKeys)]
    : fallbackOwnerKey
      ? [fallbackOwnerKey]
      : [];
  const ownerLabels = normalizedOwnerKeys.map((ownerKey) => {
    const ownerEntry = owners.find((entry) => entry.ownerKey === ownerKey);
    if (ownerEntry) {
      return _getOwnerDisplayInfo(ownerEntry, collisionIndex).title;
    }
    const candidateMatch = ownerCandidates.find(
      (candidate) => String(candidate?.ownerKey || "").trim() === ownerKey,
    );
    if (candidateMatch?.ownerName) {
      return _getOwnerDisplayInfo(
        {
          ownerKey,
          ownerName: candidateMatch.ownerName,
          ownerType: _inferOwnerTypeFromKey(ownerKey),
        },
        collisionIndex,
      ).title;
    }
    return _getOwnerDisplayInfo({ ownerKey }, collisionIndex).title;
  });

  return {
    ownerKeys: normalizedOwnerKeys,
    ownerLabels,
    resolutionMode: String(retrievalMeta.sceneOwnerResolutionMode || "").trim() || "fallback",
  };
}

function _getCurrentCognitionOwnerSummary(graph) {
  const owners = _getCognitionOwnerCollection(graph);
  const recallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeOwnerKey = String(recallOwnerInfo.ownerKeys[0] || "").trim();
  if (!owners.some((entry) => entry.ownerKey === currentCognitionOwnerKey)) {
    currentCognitionOwnerKey =
      activeOwnerKey && owners.some((entry) => entry.ownerKey === activeOwnerKey)
        ? activeOwnerKey
        : owners[0]?.ownerKey || "";
  }
  const selectedOwner =
    owners.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const activeOwner =
    owners.find((entry) => entry.ownerKey === activeOwnerKey) || null;
  return {
    owners,
    activeOwnerKeys: recallOwnerInfo.ownerKeys,
    activeOwnerLabels: recallOwnerInfo.ownerLabels,
    sceneOwnerResolutionMode: recallOwnerInfo.resolutionMode,
    activeOwnerKey,
    selectedOwner,
    activeOwner,
  };
}

function _collectNodeNames(graph, nodeIds = [], { limit = 4 } = {}) {
  const seen = new Set();
  const result = [];
  for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId || seen.has(normalizedNodeId)) continue;
    seen.add(normalizedNodeId);
    const node =
      Array.isArray(graph?.nodes)
        ? graph.nodes.find((item) => String(item?.id || "") === normalizedNodeId)
        : null;
    result.push(node ? getNodeDisplayName(node) : normalizedNodeId);
    if (result.length >= limit) break;
  }
  return result;
}

function _renderCognitionOwnerList(
  graph,
  { owners = [], activeOwnerKey = "", activeOwnerKeys = [] } = {},
) {
  const listEl = document.getElementById("bme-cognition-owner-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = "Tạm thời chưa có nhân vật nhận thức";
    listEl.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const owner of owners) {
    const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
    const li = document.createElement("li");
    li.className = "bme-cognition-owner-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bme-cognition-owner-btn";
    if (owner.ownerKey === currentCognitionOwnerKey) {
      button.classList.add("is-selected");
    }
    if (owner.ownerKey === activeOwnerKey || activeOwnerKeys.includes(owner.ownerKey)) {
      button.classList.add("is-active-anchor");
    }
    button.dataset.ownerKey = String(owner.ownerKey || "");
    button.title = displayInfo.tooltip;

    const title = document.createElement("div");
    title.className = "bme-cognition-owner-btn__title";
    title.textContent = displayInfo.title;

    const meta = document.createElement("div");
    meta.className = "bme-cognition-owner-btn__meta";
    meta.textContent = [
      displayInfo.subtitle,
      `Đã biết ${Number(owner.knownCount || 0)}`,
      `Hiểu sai ${Number(owner.mistakenCount || 0)}`,
      `Ẩn ${Number(owner.manualHiddenCount || 0)}`,
    ].join(" · ");

    button.append(title, meta);
    li.appendChild(button);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function _renderCognitionDetail(
  graph,
  {
    selectedOwner = null,
    activeOwnerKey = "",
    activeOwnerKeys = [],
    activeRegion = "",
    adjacentRegions = [],
  } = {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const detailEl = document.getElementById("bme-cognition-detail");
  if (!detailEl) return;

  if (!selectedOwner) {
    detailEl.innerHTML = `
      <div class="bme-cognition-empty">
        Vẫn chưa có nhận thức nhân vật để xem. Sau khi đi vào một đoạn hội thoại bình thường và hoàn tất trích xuất, danh sách nhân vật và chi tiết nhận thức sẽ xuất hiện ở đây.
      </div>
    `;
    return;
  }

  const ownerState =
    graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
      aliases: selectedOwner.aliases || [],
      visibilityScores: {},
      manualKnownNodeIds: [],
      manualHiddenNodeIds: [],
      mistakenNodeIds: [],
      knownNodeIds: [],
      updatedAt: 0,
      lastSource: "",
    };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({
      nodeId: String(nodeId || ""),
      score: Number(score || 0),
    }))
    .filter((entry) => entry.nodeId)
    .sort((left, right) => right.score - left.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((entry) => entry.score >= 0.68).map((entry) => entry.nodeId),
    { limit: 5 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [
      ...(ownerState.manualHiddenNodeIds || []),
      ...(ownerState.mistakenNodeIds || []),
    ],
    { limit: 5 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "Cưỡng chế đã biết"
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "Cưỡng chế ẩn"
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "hiểu sai"
          : "Chưa bao phủ"
    : "Chưa chọn nút";
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const aliases = Array.isArray(ownerState.aliases) ? ownerState.aliases : [];
  const collisionIndex = _buildOwnerCollisionIndex(_getCognitionOwnerCollection(graph));
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);

  detailEl.innerHTML = `
    <div class="bme-cognition-detail-card">
      <div class="bme-config-card-head">
        <div>
          <div class="bme-config-card-title">${_escHtml(
            displayInfo.title,
          )}</div>
          <div class="bme-config-card-subtitle">
            ${_escHtml(
              [displayInfo.subtitle, String(selectedOwner.ownerKey || "")]
                .filter(Boolean)
                .join(" · "),
            )}
          </div>
        </div>
        ${
          selectedOwner.ownerKey === activeOwnerKey ||
          activeOwnerKeys.includes(selectedOwner.ownerKey)
            ? '<span class="bme-task-pill">Neo cảnh hiện tại</span>'
            : ""
        }
      </div>

      <div class="bme-cognition-metrics">
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">Neo đã biết</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.knownCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">Nút hiểu sai</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.mistakenCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">Hiển thị mạnh</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(strongVisibleNames.length),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">Bị áp chế</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size),
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-line-list">
        <div class="bme-cognition-line">
          <span>Bí danh</span>
          <strong>${_escHtml(aliases.length ? aliases.join(" / ") : "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>Khu vực hiện tại</span>
          <strong>${_escHtml(activeRegion || "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>Khu vực kề</span>
          <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>Gần nhấtCập nhật</span>
          <strong>${_escHtml(
            ownerState.updatedAt ? _formatTaskProfileTime(new Date(ownerState.updatedAt).toISOString()) : "Chưa có",
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">Hiển thị mạnhnút</div>
        <div class="bme-cognition-chip-wrap">
          ${
            strongVisibleNames.length
              ? strongVisibleNames
                  .map((name) => `<span class="bme-cognition-chip">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">Chưa có</span>'
          }
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">Bị áp chếnút</div>
        <div class="bme-cognition-chip-wrap">
          ${
            suppressedNames.length
              ? suppressedNames
                  .map((name) => `<span class="bme-cognition-chip is-muted">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">Chưa có</span>'
          }
        </div>
      </div>

      <div class="bme-cognition-node-override">
        <div class="bme-cognition-node-override__title">Ghi đè thủ công lên nút đang chọn</div>
        <div class="bme-config-help">
          ${
            selectedNode
              ? `Nút hiện tại: ${_escHtml(selectedNodeLabel)} · Trạng thái hiện tại của nhân vật này: ${_escHtml(selectedNodeState)}`
              : "Hãy chọn một nút trong đồ thị hoặc danh sách ký ức trước, rồi quay lại đặt bao phủ thủ công."
          }
        </div>
        <div class="bme-cognition-node-actions">
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="known"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            Cưỡng chế đã biết
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="hidden"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            Cưỡng chế ẩn
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="mistaken"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            Đánh dấu hiểu sai
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="clear"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            Xóa ghi đè
          </button>
        </div>
      </div>
    </div>
  `;
}

function _refreshCognitionDashboard(
  graph,
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const canRenderGraph =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");
  const manualRegionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  if (manualRegionInput) manualRegionInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);
  if (adjacencyInput) adjacencyInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);

  if (!canRenderGraph) {
    _setText("bme-cognition-active-owner", "—");
    _setText("bme-cognition-active-region", _getGraphLoadLabel(loadInfo));
    _setText("bme-cognition-adjacent-regions", "—");
    _setText("bme-cognition-owner-count", "—");
    _renderStatefulListPlaceholder(
      document.getElementById("bme-cognition-owner-list"),
      _getGraphLoadLabel(loadInfo),
    );
    const detailEl = document.getElementById("bme-cognition-detail");
    if (detailEl) {
      detailEl.innerHTML = `
        <div class="bme-cognition-empty">${_escHtml(_getGraphLoadLabel(loadInfo))}</div>
      `;
    }
    _setInputValueIfIdle("bme-cognition-manual-region", "");
    _setInputValueIfIdle("bme-cognition-adjacency-input", "");
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const {
    owners,
    activeOwnerKey,
    activeOwnerLabels,
    selectedOwner,
    activeOwner,
  } = _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${
        historyState.activeRegionSource ? ` · ${historyState.activeRegionSource}` : ""
      }`
    : "—";
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  _setText(
    "bme-cognition-active-owner",
    activeOwnerLabels.length > 0
      ? activeOwnerLabels.join(" / ")
      : activeOwner
        ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
        : activeOwnerKey || "—",
  );
  _setText("bme-cognition-active-region", activeRegionLabel || "—");
  _setText(
    "bme-cognition-adjacent-regions",
    adjacentRegions.length > 0 ? adjacentRegions.join(" / ") : "—",
  );
  _setText("bme-cognition-owner-count", owners.length);
  // Cognition view workspace refresh (if visible)
  if (currentGraphView === "cognition") {
    _refreshCognitionWorkspace();
  }
}

function _refreshAiMonitorDashboard() {
  const settings = _getSettings?.() || {};
  if (settings.enableAiMonitor !== true) {
    _renderMiniRecentList(
      "bme-ai-monitor-list",
      [],
      "Giám sát tác vụ đã tắt",
    );
    return;
  }

  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const timeline = Array.isArray(runtimeDebug?.runtimeDebug?.taskTimeline)
    ? runtimeDebug.runtimeDebug.taskTimeline
    : [];
  _renderMiniRecentList(
    "bme-ai-monitor-list",
    timeline
      .slice(-6)
      .reverse()
      .map((entry) => {
        const route =
          _getMonitorRouteLabel(entry?.route) ||
          _getMonitorRouteLabel(entry?.llmConfigSourceLabel) ||
          "";
        const model = String(entry?.model || "").trim();
        const durationText =
          Number.isFinite(Number(entry?.durationMs)) && Number(entry.durationMs) > 0
            ? `${Math.round(Number(entry.durationMs))}ms`
            : "";
        return [
          _getMonitorTaskTypeLabel(entry?.taskType),
          _getMonitorStatusLabel(entry?.status),
          route || model ? `${route || model}` : "",
          durationText,
        ]
          .filter(Boolean)
          .join(" · ");
      }),
    "Tạm thời chưa có dòng thời gian tác vụ",
  );
}

function _renderRecentList(elementId, items) {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    const text = document.createElement("div");
    text.className = "bme-recent-text";
    text.style.color = "var(--bme-on-surface-dim)";
    text.textContent = "Tạm thời chưa có dữ liệu";
    li.appendChild(text);
    listEl.replaceChildren(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const secondary = item.meta || item.time || "";
    const li = document.createElement("li");
    li.className = "bme-recent-item";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(item.type)}`;
    badge.textContent = _typeLabel(item.type);
    li.appendChild(badge);

    const content = document.createElement("div");
    const title = document.createElement("div");
    title.className = "bme-recent-text";
    title.textContent = item.name || "—";
    const meta = document.createElement("div");
    meta.className = "bme-recent-meta";
    meta.textContent = secondary;
    content.append(title, meta);
    li.appendChild(content);

    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);
}

// ==================== Trình duyệt ký ức ====================

function _refreshMemoryBrowser() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const searchInput = document.getElementById("bme-memory-search");
  const regionInput = document.getElementById("bme-memory-region-filter");
  const floorInput = document.getElementById("bme-memory-floor-filter");
  const filterSelect = document.getElementById("bme-memory-filter");
  const listEl = document.getElementById("bme-memory-list");
  if (!listEl) return;

  const canRenderGraph = _canRenderGraphData(loadInfo);
  if (searchInput) searchInput.disabled = !canRenderGraph;
  if (regionInput) regionInput.disabled = !canRenderGraph;
  if (floorInput) floorInput.disabled = !canRenderGraph;
  if (filterSelect) filterSelect.disabled = !canRenderGraph;

  if (!canRenderGraph && loadInfo.loadState !== "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, _getGraphLoadLabel(loadInfo));
    return;
  }

  const query = String(searchInput?.value || "")
    .trim()
    .toLowerCase();
  const regionQuery = String(regionInput?.value || "")
    .trim()
    .toLowerCase();
  const filter = filterSelect?.value || "all";

  let nodes = graph.nodes.filter((node) => !node.archived);
  if (filter !== "all") {
    nodes = nodes.filter((node) => _matchesMemoryFilter(node, filter));
  }
  if (query) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const text = JSON.stringify(node.fields || {}).toLowerCase();
      return name.includes(query) || text.includes(query);
    });
  }
  if (regionQuery) {
    nodes = nodes.filter((node) => {
      const scope = normalizeMemoryScope(node.scope);
      const regionText = [
        scope.regionPrimary,
        ...(scope.regionPath || []),
        ...(scope.regionSecondary || []),
      ]
        .join(" ")
        .toLowerCase();
      return regionText.includes(regionQuery);
    });
  }

  const floorQuery = String(floorInput?.value || "").trim();
  if (floorQuery) {
    const floorFilter = _parseFloorFilter(floorQuery);
    if (floorFilter) {
      nodes = nodes.filter((node) => _matchesFloorFilter(node, floorFilter));
    }
  }

  nodes.sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  if (!nodes.length && loadInfo.loadState === "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, "Chat hiện tại vẫn chưa có đồ thị");
    return;
  }

  const fragment = document.createDocumentFragment();
  nodes.slice(0, 100).forEach((node) => {
    const name = getNodeDisplayName(node);
    const snippetText = _getNodeSnippet(node);
    const li = document.createElement("li");
    li.className = "bme-memory-item";
    li.dataset.nodeId = String(node.id || "");

    const card = document.createElement("div");
    card.className = "bme-memory-card";

    const head = document.createElement("div");
    head.className = "bme-memory-card-head";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(node.type)}`;
    badge.textContent = _typeLabel(node.type);

    const scopeChip = document.createElement("span");
    scopeChip.className = "bme-memory-scope-chip";
    scopeChip.textContent = buildScopeBadgeText(node.scope);

    head.append(badge, scopeChip);

    const titleEl = document.createElement("div");
    titleEl.className = "bme-memory-name";
    titleEl.textContent = name;

    const snippetEl = document.createElement("div");
    snippetEl.className = "bme-memory-content";
    snippetEl.textContent = snippetText;

    const foot = document.createElement("div");
    foot.className = "bme-memory-foot";

    const stats = document.createElement("div");
    stats.className = "bme-memory-stats";

    const impSpan = document.createElement("span");
    impSpan.className = "bme-memory-stat-pill";
    impSpan.textContent = `Độ quan trọng ${_formatMemoryMetricNumber(node.importance, {
      fallback: 5,
      maxFrac: 2,
    })}`;

    const accSpan = document.createElement("span");
    accSpan.className = "bme-memory-stat-pill";
    accSpan.textContent = `Lượt truy cập ${_formatMemoryInt(node.accessCount, 0)}`;

    const seqSpan = document.createElement("span");
    seqSpan.className = "bme-memory-stat-pill";
    seqSpan.textContent = `Chuỗi ${_formatMemoryInt(
      node.seqRange?.[1] ?? node.seq,
      0,
    )}`;

    stats.append(impSpan, accSpan, seqSpan);
    foot.appendChild(stats);

    const regionMeta = _buildScopeMetaText(node);
    if (regionMeta) {
      const regionEl = document.createElement("div");
      regionEl.className = "bme-memory-region";
      regionEl.textContent = regionMeta;
      foot.appendChild(regionEl);
    }

    card.append(head, titleEl, snippetEl, foot);
    li.appendChild(card);
    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);

  listEl.querySelectorAll(".bme-memory-item").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.dataset.nodeId;
      graphRenderer?.highlightNode(nodeId);
      mobileGraphRenderer?.highlightNode(nodeId);
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (node) _showNodeDetail(node);
    });
  });

  if (searchInput && !searchInput._bmeBound) {
    let timer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    regionInput?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    floorInput?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    filterSelect?.addEventListener("change", () => _refreshMemoryBrowser());
    searchInput._bmeBound = true;
  }
}

// ==================== Xem trước tiêm ====================

async function _refreshInjectionPreview() {
  const container = document.getElementById("bme-injection-content");
  const tokenEl = document.getElementById("bme-injection-tokens");
  if (!container) return;

  const injection = String(_getLastInjection?.() || "").trim();
  if (!injection) {
    const empty = document.createElement("div");
    empty.className = "bme-injection-preview";
    empty.style.color = "var(--bme-on-surface-dim)";
    empty.textContent = "Tạm thời chưa có nội dung tiêm. Hãy hoàn tất một lần truy hồi hoặc sinh bình thường rồi quay lại xem.";
    container.replaceChildren(empty);
    if (tokenEl) tokenEl.textContent = "";
    return;
  }

  try {
    const { estimateTokens } = await import("../retrieval/injector.js");
    const totalTokens = estimateTokens(injection);
    const preview = _buildInjectionPreviewNode(injection);
    container.replaceChildren(preview);
    if (tokenEl) tokenEl.textContent = `≈ ${totalTokens} tokens`;
  } catch (error) {
    const failure = document.createElement("div");
    failure.className = "bme-injection-preview";
    failure.style.color = "var(--bme-accent3)";
    failure.textContent = `Xem trước phản hồi thất bại: ${error.message}`;
    container.replaceChildren(failure);
    if (tokenEl) tokenEl.textContent = "";
  }
}

function _buildInjectionPreviewNode(injectionText = "") {
  const parsed = _parseInjectionPreview(String(injectionText || ""));
  if (!parsed.sections.length) {
    const preview = document.createElement("div");
    preview.className = "bme-injection-preview";
    preview.textContent = injectionText;
    return preview;
  }

  const root = document.createElement("div");
  root.className = "bme-injection-rich";

  const hint = document.createElement("div");
  hint.className = "bme-injection-rich__hint";
  hint.textContent = "Đây là bản xem trước đã cấu trúc để dễ đọc; phần thực sự gửi cho model vẫn là văn bản tiêm gốc.";
  root.appendChild(hint);

  for (const section of parsed.sections) {
    const card = document.createElement("section");
    card.className = `bme-injection-card ${_getInjectionSectionFlavor(section.title)}`;

    const title = document.createElement("div");
    title.className = "bme-injection-card__title";
    title.textContent = section.title;
    card.appendChild(title);

    if (section.note) {
      const note = document.createElement("div");
      note.className = "bme-injection-card__note";
      note.textContent = section.note;
      card.appendChild(note);
    }

    for (const block of section.blocks) {
      if (block.type === "table") {
        card.appendChild(_buildInjectionTableNode(block));
      } else if (block.type === "text" && block.text) {
        const text = document.createElement("div");
        text.className = "bme-injection-card__text";
        text.textContent = block.text;
        card.appendChild(text);
      }
    }

    root.appendChild(card);
  }

  return root;
}

function _parseInjectionPreview(injectionText = "") {
  const lines = String(injectionText || "").replace(/\r/g, "").split("\n");
  const sections = [];
  let index = 0;
  let currentSection = null;

  function ensureSection(title = "Memory") {
    if (!currentSection) {
      currentSection = {
        title,
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const sectionMatch = line.match(/^\[(Memory\s*-\s*.+)]$/i);
    if (sectionMatch) {
      currentSection = {
        title: sectionMatch[1],
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
      index += 1;

      const noteCandidate = (lines[index] ?? "").trim();
      if (
        noteCandidate &&
        !noteCandidate.startsWith("[") &&
        !noteCandidate.endsWith(":") &&
        !noteCandidate.startsWith("|") &&
        !noteCandidate.startsWith("## ")
      ) {
        currentSection.note = noteCandidate;
        index += 1;
      }
      continue;
    }

    const section = ensureSection();

    if (line.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|")) {
      const tableName = line.slice(0, -1).trim();
      const tableLines = [];
      index += 1;
      while (index < lines.length) {
        const tableLine = String(lines[index] || "");
        if (!tableLine.trim().startsWith("|")) {
          break;
        }
        tableLines.push(tableLine.trim());
        index += 1;
      }
      const parsedTable = _parseInjectionTable(tableName, tableLines);
      if (parsedTable) {
        section.blocks.push(parsedTable);
      }
      continue;
    }

    const textLines = [];
    while (index < lines.length) {
      const candidate = String(lines[index] || "").trim();
      if (!candidate) {
        index += 1;
        if (textLines.length > 0) {
          break;
        }
        continue;
      }
      if (
        /^\[(Memory\s*-\s*.+)]$/i.test(candidate) ||
        (candidate.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|"))
      ) {
        break;
      }
      textLines.push(candidate);
      index += 1;
    }
    if (textLines.length > 0) {
      section.blocks.push({
        type: "text",
        text: textLines.join("\n"),
      });
    }
  }

  return { sections };
}

function _parseInjectionTable(tableName, tableLines = []) {
  if (!Array.isArray(tableLines) || tableLines.length < 2) {
    return null;
  }

  const headerCells = _splitInjectionTableRow(tableLines[0]);
  if (!headerCells.length) {
    return null;
  }

  const rows = tableLines
    .slice(2)
    .map((row) => _splitInjectionTableRow(row))
    .filter((cells) => cells.length > 0);

  return {
    type: "table",
    name: tableName,
    headers: headerCells,
    rows,
  };
}

function _splitInjectionTableRow(row = "") {
  const text = String(row || "").trim();
  if (!text.startsWith("|")) {
    return [];
  }

  const inner = text.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function _buildInjectionTableNode(table) {
  const wrap = document.createElement("div");
  wrap.className = "bme-injection-table-wrap";

  const name = document.createElement("div");
  name.className = "bme-injection-table-name";
  name.textContent = table.name;
  wrap.appendChild(name);

  const tableEl = document.createElement("table");
  tableEl.className = "bme-injection-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of table.headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    const normalizedCells = table.headers.map((_, idx) => row[idx] ?? "");
    for (const cell of normalizedCells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tableEl.appendChild(tbody);
  wrap.appendChild(tableEl);
  return wrap;
}

function _getInjectionSectionFlavor(title = "") {
  const normalized = String(title || "").toLowerCase();
  if (normalized.includes("character pov")) return "character-pov";
  if (normalized.includes("user pov")) return "user-pov";
  if (normalized.includes("current region")) return "objective-current";
  if (normalized.includes("global")) return "objective-global";
  return "generic";
}

// ==================== đồ thị ====================

/** SillyTavern tên hiển thị người dùng（name1），dùng chophân vùng đồ thị：POV người dùng bị gắn nhầm là nhân vật sẽ bị ép trả về vùng người dùng */
function _hostUserPovAliasHintsForGraph() {
  return getHostUserAliasHints();
}

function _refreshGraph(options = {}) {
  return _refreshVisibleGraphWorkspace({ force: options.force !== false });
}

function _buildLegend() {
  const legendEl = document.getElementById("bme-graph-legend");
  if (!legendEl) return;

  const settings = _getSettings?.() || {};
  const colors = getNodeColors(settings.panelTheme || "crimson");
  const scopeColors = {
    objective: "#57c7ff",
    characterPov: "#ffb347",
    userPov: "#7dff9b",
  };
  const layers = [
    { key: "objective", label: "Tầng khách quan" },
    { key: "characterPov", label: "POV nhân vật" },
    { key: "userPov", label: "POV người dùng" },
  ];
  const types = [
    { key: "character", label: "Nhân vật" },
    { key: "event", label: "Sự kiện" },
    { key: "location", label: "Địa điểm" },
    { key: "thread", label: "tuyến chính" },
    { key: "rule", label: "Quy tắc" },
    { key: "synopsis", label: "Tóm lược toàn cục (cũ)" },
    { key: "reflection", label: "Phản tư" },
    { key: "pov_memory", label: "Ký ức chủ quan" },
  ];

  const fragment = document.createDocumentFragment();
  layers.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = scopeColors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  types.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = colors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  legendEl.replaceChildren(fragment);
}

function _getActiveGraphRenderer() {
  return mobileGraphRenderer || graphRenderer;
}

function _resolveVisibleGraphRenderer() {
  const visibleMode = _getVisibleGraphWorkspaceMode();
  if (visibleMode.startsWith("mobile:")) {
    return mobileGraphRenderer || graphRenderer;
  }
  if (visibleMode.startsWith("desktop:")) {
    return graphRenderer || mobileGraphRenderer;
  }
  return _getActiveGraphRenderer();
}

function _formatGraphLayoutDiagnosticsText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return "LAYOUT: --";
  }

  const modeRaw = String(
    diagnostics.mode || diagnostics.solver || "",
  ).trim();
  const modeMap = {
    "js-main": "JS-main",
    "js-worker": "JS-worker",
    "rust-wasm-worker": "Rust-WASM",
    "js-fallback": "JS-fallback",
    skipped: "skipped",
    "native-stale": "stale",
    "native-failed-hard": "native-failed",
  };
  const modeLabel = modeMap[modeRaw] || modeRaw || "unknown";

  const totalMs = Number(
    diagnostics.totalMs ?? diagnostics.solveMs ?? diagnostics.workerSolveMs,
  );
  const nodeCount = Number(diagnostics.nodeCount);
  const edgeCount = Number(diagnostics.edgeCount);

  const parts = [`LAYOUT: ${modeLabel}`];
  if (Number.isFinite(totalMs)) {
    parts.push(`${Math.max(0, Math.round(totalMs))}ms`);
  }
  if (Number.isFinite(nodeCount) && Number.isFinite(edgeCount)) {
    parts.push(
      `${Math.max(0, Math.floor(nodeCount))}/${Math.max(
        0,
        Math.floor(edgeCount),
      )}`,
    );
  }

  return parts.join(" · ");
}

function _refreshGraphLayoutDiagnosticsUi() {
  const desktopMeta = document.getElementById("bme-graph-layout-meta");
  const mobileMeta = document.getElementById("bme-mobile-graph-layout-meta");
  if (!desktopMeta && !mobileMeta) return;

  const renderer = _resolveVisibleGraphRenderer();
  const diagnostics = renderer?.getLastLayoutDiagnostics?.() || null;
  const text = _formatGraphLayoutDiagnosticsText(diagnostics);
  const title = diagnostics?.reason
    ? `layout reason: ${String(diagnostics.reason).trim()}`
    : "";

  if (desktopMeta) {
    desktopMeta.textContent = text;
    if (title) {
      desktopMeta.title = title;
    } else {
      desktopMeta.removeAttribute("title");
    }
  }

  if (mobileMeta) {
    mobileMeta.textContent = text;
    if (title) {
      mobileMeta.title = title;
    } else {
      mobileMeta.removeAttribute("title");
    }
  }
}

function _bindGraphControls() {
  document
    .getElementById("bme-graph-render-toggle")
    ?.addEventListener("click", () => _toggleGraphRenderingEnabled());
  document
    .getElementById("bme-graph-zoom-in")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomIn());
  document
    .getElementById("bme-graph-zoom-out")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomOut());
  document
    .getElementById("bme-graph-reset")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.resetView());
}

// ==================== Chi tiết nút ====================

const STORY_TIME_TENSE_OPTIONS = Object.freeze([
  { value: "past", label: "Quá khứ" },
  { value: "ongoing", label: "đang diễn raTrung bình" },
  { value: "future", label: "tương lai" },
  { value: "flashback", label: "Hồi tưởng" },
  { value: "hypothetical", label: "Giả định" },
  { value: "unknown", label: "Không rõ" },
]);

const STORY_TIME_RELATION_OPTIONS = Object.freeze([
  { value: "same", label: "Cùng thời điểm" },
  { value: "after", label: "Sau mốc neo" },
  { value: "before", label: "Trước mốc neo" },
  { value: "parallel", label: "Song song với mốc neo" },
  { value: "unknown", label: "Không rõ" },
]);

const STORY_TIME_CONFIDENCE_OPTIONS = Object.freeze([
  { value: "high", label: "Cao" },
  { value: "medium", label: "Trung bình" },
  { value: "low", label: "Thấp" },
]);

const STORY_TIME_SOURCE_OPTIONS = Object.freeze([
  { value: "extract", label: "Trích xuất" },
  { value: "derived", label: "Suy diễn" },
  { value: "manual", label: "Thủ công" },
]);

const STORY_TIME_MIXED_OPTIONS = Object.freeze([
  { value: "false", label: "Không" },
  { value: "true", label: "Có" },
]);

function _resolveNodeDetailOptionLabel(options = [], value, fallback = "") {
  return (
    options.find((option) => option.value === String(value ?? ""))?.label ||
    fallback ||
    String(value ?? "")
  );
}

function _describeStoryTimeDisplay(storyTime = {}) {
  const normalized = normalizeStoryTime(storyTime);
  if (!normalized.label) return "";

  const parts = [normalized.label];
  if (normalized.tense && normalized.tense !== "unknown") {
    parts.push(
      _resolveNodeDetailOptionLabel(STORY_TIME_TENSE_OPTIONS, normalized.tense),
    );
  }
  if (
    normalized.relation &&
    normalized.relation !== "unknown" &&
    normalized.relation !== "same"
  ) {
    const relationLabel = _resolveNodeDetailOptionLabel(
      STORY_TIME_RELATION_OPTIONS,
      normalized.relation,
    );
    parts.push(
      normalized.anchorLabel
        ? `${relationLabel} · ${normalized.anchorLabel}`
        : relationLabel,
    );
  } else if (normalized.anchorLabel) {
    parts.push(`mốc neo · ${normalized.anchorLabel}`);
  }

  return parts.join(" · ");
}

function _describeStoryTimeSpanDisplay(storyTimeSpan = {}) {
  const normalized = normalizeStoryTimeSpan(storyTimeSpan);
  const label =
    normalized.startLabel &&
    normalized.endLabel &&
    normalized.startLabel !== normalized.endLabel
      ? `${normalized.startLabel} → ${normalized.endLabel}`
      : normalized.startLabel || normalized.endLabel || "";

  if (!label) {
    return normalized.mixed ? "trộnthời gian" : "";
  }
  return normalized.mixed ? `${label} · trộn` : label;
}

function _describeNodeStoryTimeDisplay(node = {}) {
  return (
    _describeStoryTimeDisplay(node.storyTime) ||
    _describeStoryTimeSpanDisplay(node.storyTimeSpan) ||
    ""
  );
}

function _appendNodeDetailReadOnly(container, labelText, valueText) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = String(valueText ?? "—");
  row.append(label, value);
  container.appendChild(row);
}

function _appendNodeDetailNumberInput(
  container,
  labelText,
  inputId,
  value,
  { min, max, step } = {},
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  if (step != null) input.step = String(step);
  input.value =
    value === undefined || value === null ? "" : String(Number(value));
  row.append(label, input);
  container.appendChild(row);
}

function _appendNodeDetailTextInput(container, labelText, inputId, value) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  input.value = String(value ?? "");
  row.append(label, input);
  container.appendChild(row);
}

function _appendNodeDetailSelectInput(
  container,
  labelText,
  inputId,
  value,
  options = [],
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const select = document.createElement("select");
  select.id = inputId;
  select.className = "bme-node-detail-input";
  options.forEach((option) => {
    const optEl = document.createElement("option");
    optEl.value = option.value;
    optEl.textContent = option.label;
    select.appendChild(optEl);
  });
  select.value = String(value ?? "");
  row.append(label, select);
  container.appendChild(row);
}

function _parseNodeDetailScopeList(rawValue, { allowSlash = true } = {}) {
  const normalized = String(rawValue ?? "")
    .replace(/[＞>→]+/g, "/")
    .replace(/\r/g, "\n");
  const separatorPattern = allowSlash ? /[,\n，/\\]+/ : /[,\n，]+/;
  const values = normalized
    .split(separatorPattern)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function _appendNodeDetailTextareaField(
  container,
  labelText,
  fieldKey,
  fieldType,
  text,
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const ta = document.createElement("textarea");
  ta.className = "bme-node-detail-textarea";
  ta.dataset.bmeFieldKey = fieldKey;
  ta.dataset.bmeFieldType = fieldType;
  ta.rows = String(text || "").length > 160 ? 6 : 3;
  ta.value = text;
  row.append(label, ta);
  container.appendChild(row);
}

function _buildNodeDetailEditorFragment(raw, { idPrefix = "bme-detail" } = {}) {
  const fields = raw.fields || {};
  const scope = normalizeMemoryScope(raw.scope);
  const storyTime = normalizeStoryTime(raw.storyTime);
  const storyTimeSpan = normalizeStoryTimeSpan(raw.storyTimeSpan);
  const fragment = document.createDocumentFragment();
  const inputId = (suffix) => `${idPrefix}-${suffix}`;

  _appendNodeDetailReadOnly(fragment, "Loại", _typeLabel(raw.type));
  _appendNodeDetailReadOnly(
    fragment,
    "Phạm vi tác dụng",
    buildScopeBadgeText(raw.scope),
  );
  _appendNodeDetailReadOnly(fragment, "ID", raw.id || "—");
  _appendNodeDetailReadOnly(
    fragment,
    "Số thứ tự",
    raw.seqRange?.[1] ?? raw.seq ?? 0,
  );

  if (scope.layer === "pov") {
    _appendNodeDetailReadOnly(
      fragment,
      "POV quy thuộc",
      `${scope.ownerType || "unknown"} / ${scope.ownerName || scope.ownerId || "—"}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) {
    _appendNodeDetailReadOnly(fragment, "khu vực", regionLine);
  }
  _appendNodeDetailTextInput(
    fragment,
    "Khu vực chính",
    inputId("scope-region-primary"),
    scope.regionPrimary || "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "Đường đi khu vực (ngăn bằng /)",
    inputId("scope-region-path"),
    Array.isArray(scope.regionPath) ? scope.regionPath.join(" / ") : "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "Khu vực cấp phụ (ngăn bằng dấu phẩy hoặc /)",
    inputId("scope-region-secondary"),
    Array.isArray(scope.regionSecondary)
      ? scope.regionSecondary.join(", ")
      : "",
  );
  if (Array.isArray(raw.seqRange)) {
    _appendNodeDetailReadOnly(
      fragment,
      "Phạm vi chuỗi",
      `${raw.seqRange[0]} ~ ${raw.seqRange[1]}`,
    );
  }
  const storyTimeSection = document.createElement("div");
  storyTimeSection.className = "bme-node-detail-section";
  storyTimeSection.textContent = "thời gian cốt truyện";
  fragment.appendChild(storyTimeSection);
  _appendNodeDetailReadOnly(
    fragment,
    "hiện tạitóm tắt",
    _describeStoryTimeDisplay(storyTime) || "—",
  );
  _appendNodeDetailTextInput(
    fragment,
    "thời giannhãn",
    inputId("story-time-label"),
    storyTime.label,
  );
  _appendNodeDetailSelectInput(
    fragment,
    "Thì thời gian",
    inputId("story-time-tense"),
    storyTime.tense,
    STORY_TIME_TENSE_OPTIONS,
  );

  const storyTimeAdvanced = document.createElement("details");
  storyTimeAdvanced.className = "bme-node-detail-collapse";
  const storyTimeAdvancedSummary = document.createElement("summary");
  storyTimeAdvancedSummary.textContent = "Nâng cao";
  storyTimeAdvanced.appendChild(storyTimeAdvancedSummary);
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "Tương đốiquan hệ",
    inputId("story-time-relation"),
    storyTime.relation,
    STORY_TIME_RELATION_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeAdvanced,
    "mốc neonhãn",
    inputId("story-time-anchor-label"),
    storyTime.anchorLabel,
  );
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "Độ tin cậy",
    inputId("story-time-confidence"),
    storyTime.confidence,
    STORY_TIME_CONFIDENCE_OPTIONS,
  );
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "Nguồn",
    inputId("story-time-source"),
    storyTime.source,
    STORY_TIME_SOURCE_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeAdvanced,
    "ID đoạn",
    inputId("story-time-segment-id"),
    storyTime.segmentId,
  );
  fragment.appendChild(storyTimeAdvanced);

  const storyTimeSpanCollapse = document.createElement("details");
  storyTimeSpanCollapse.className = "bme-node-detail-collapse";
  const storyTimeSpanSummaryEl = document.createElement("summary");
  storyTimeSpanSummaryEl.className = "bme-node-detail-section";
  storyTimeSpanSummaryEl.textContent = "thời gian cốt truyệnPhạm vi";
  storyTimeSpanCollapse.appendChild(storyTimeSpanSummaryEl);
  _appendNodeDetailReadOnly(
    storyTimeSpanCollapse,
    "Phạm vi hiện tại",
    _describeStoryTimeSpanDisplay(storyTimeSpan) || "—",
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "điểm bắt đầunhãn",
    inputId("story-time-span-start-label"),
    storyTimeSpan.startLabel,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "Nhãn điểm cuối",
    inputId("story-time-span-end-label"),
    storyTimeSpan.endLabel,
  );
  _appendNodeDetailSelectInput(
    storyTimeSpanCollapse,
    "trộnthời gian",
    inputId("story-time-span-mixed"),
    storyTimeSpan.mixed ? "true" : "false",
    STORY_TIME_MIXED_OPTIONS,
  );
  _appendNodeDetailSelectInput(
    storyTimeSpanCollapse,
    "Nguồn",
    inputId("story-time-span-source"),
    storyTimeSpan.source,
    STORY_TIME_SOURCE_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "ID đoạn điểm bắt đầu",
    inputId("story-time-span-start-segment-id"),
    storyTimeSpan.startSegmentId,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "ID đoạn điểm cuối",
    inputId("story-time-span-end-segment-id"),
    storyTimeSpan.endSegmentId,
  );
  fragment.appendChild(storyTimeSpanCollapse);

  _appendNodeDetailNumberInput(
    fragment,
    "Độ quan trọng (0–10)",
    inputId("importance"),
    raw.importance ?? 5,
    { min: 0, max: 10, step: 0.1 },
  );
  _appendNodeDetailNumberInput(
    fragment,
    "Số lần truy cập",
    inputId("accesscount"),
    raw.accessCount ?? 0,
    { min: 0, step: 1 },
  );

  const clustersStr = Array.isArray(raw.clusters)
    ? raw.clusters.join(", ")
    : "";
  _appendNodeDetailTextInput(
    fragment,
    "Nhãn cụm (ngăn bằng dấu phẩy)",
    inputId("clusters"),
    clustersStr,
  );

  const section = document.createElement("div");
  section.className = "bme-node-detail-section";
  section.textContent = "Trường ký ức";
  fragment.appendChild(section);

  for (const [key, value] of Object.entries(fields)) {
    const isJson = typeof value === "object" && value !== null;
    const displayVal = isJson
      ? JSON.stringify(value, null, 2)
      : String(value ?? "");
    _appendNodeDetailTextareaField(
      fragment,
      key,
      key,
      isJson ? "json" : "string",
      displayVal,
    );
  }

  return fragment;
}

function _collectNodeDetailEditorUpdates(bodyEl, { idPrefix = "bme-detail" } = {}) {
  if (!bodyEl) {
    return { ok: false, errorMessage: "Không tìm thấy biểu mẫu có thể chỉnh sửa" };
  }

  const findInput = (suffix) =>
    bodyEl.querySelector(`#${idPrefix}-${suffix}`);
  const updates = { fields: {} };
  const impEl = findInput("importance");
  if (impEl && impEl.value !== "") {
    const imp = Number.parseFloat(impEl.value);
    if (Number.isFinite(imp)) {
      updates.importance = Math.max(0, Math.min(10, imp));
    }
  }
  const accessEl = findInput("accesscount");
  if (accessEl && accessEl.value !== "") {
    const ac = Number.parseInt(accessEl.value, 10);
    if (Number.isFinite(ac)) {
      updates.accessCount = Math.max(0, ac);
    }
  }
  const clustersEl = findInput("clusters");
  if (clustersEl) {
    updates.clusters = clustersEl.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const regionPrimaryEl = findInput("scope-region-primary");
  const regionPathEl = findInput("scope-region-path");
  const regionSecondaryEl = findInput("scope-region-secondary");
  if (regionPrimaryEl || regionPathEl || regionSecondaryEl) {
    updates.scope = {
      regionPrimary: String(regionPrimaryEl?.value || "").trim(),
      regionPath: _parseNodeDetailScopeList(regionPathEl?.value, {
        allowSlash: true,
      }),
      regionSecondary: _parseNodeDetailScopeList(regionSecondaryEl?.value, {
        allowSlash: true,
      }),
    };
  }

  const storyTimeLabelEl = findInput("story-time-label");
  const storyTimeTenseEl = findInput("story-time-tense");
  const storyTimeRelationEl = findInput("story-time-relation");
  const storyTimeAnchorLabelEl = findInput("story-time-anchor-label");
  const storyTimeConfidenceEl = findInput("story-time-confidence");
  const storyTimeSourceEl = findInput("story-time-source");
  const storyTimeSegmentIdEl = findInput("story-time-segment-id");
  if (
    storyTimeLabelEl ||
    storyTimeTenseEl ||
    storyTimeRelationEl ||
    storyTimeAnchorLabelEl ||
    storyTimeConfidenceEl ||
    storyTimeSourceEl ||
    storyTimeSegmentIdEl
  ) {
    updates.storyTime = normalizeStoryTime({
      segmentId: String(storyTimeSegmentIdEl?.value || "").trim(),
      label: String(storyTimeLabelEl?.value || "").trim(),
      tense: String(storyTimeTenseEl?.value || ""),
      relation: String(storyTimeRelationEl?.value || ""),
      anchorLabel: String(storyTimeAnchorLabelEl?.value || "").trim(),
      confidence: String(storyTimeConfidenceEl?.value || ""),
      source: String(storyTimeSourceEl?.value || ""),
    });
  }

  const storyTimeSpanStartLabelEl = findInput("story-time-span-start-label");
  const storyTimeSpanEndLabelEl = findInput("story-time-span-end-label");
  const storyTimeSpanMixedEl = findInput("story-time-span-mixed");
  const storyTimeSpanSourceEl = findInput("story-time-span-source");
  const storyTimeSpanStartSegmentIdEl = findInput(
    "story-time-span-start-segment-id",
  );
  const storyTimeSpanEndSegmentIdEl = findInput(
    "story-time-span-end-segment-id",
  );
  if (
    storyTimeSpanStartLabelEl ||
    storyTimeSpanEndLabelEl ||
    storyTimeSpanMixedEl ||
    storyTimeSpanSourceEl ||
    storyTimeSpanStartSegmentIdEl ||
    storyTimeSpanEndSegmentIdEl
  ) {
    updates.storyTimeSpan = normalizeStoryTimeSpan({
      startSegmentId: String(storyTimeSpanStartSegmentIdEl?.value || "").trim(),
      endSegmentId: String(storyTimeSpanEndSegmentIdEl?.value || "").trim(),
      startLabel: String(storyTimeSpanStartLabelEl?.value || "").trim(),
      endLabel: String(storyTimeSpanEndLabelEl?.value || "").trim(),
      mixed: String(storyTimeSpanMixedEl?.value || "false") === "true",
      source: String(storyTimeSpanSourceEl?.value || ""),
    });
  }

  const fieldEls = bodyEl.querySelectorAll("[data-bme-field-key]");
  for (const el of fieldEls) {
    const key = el.dataset.bmeFieldKey;
    const type = el.dataset.bmeFieldType || "string";
    const rawVal = el.value;
    if (type === "json") {
      try {
        updates.fields[key] = JSON.parse(rawVal || "null");
      } catch {
        return {
          ok: false,
          errorMessage: `Trường "${key}" phải là JSON hợp lệ`,
        };
      }
    } else {
      updates.fields[key] = rawVal;
    }
  }

  return { ok: true, updates };
}

function _persistNodeDetailEdits(nodeId, updates, { afterSuccess } = {}) {
  if (!nodeId) return false;
  if (_isGraphWriteBlocked()) {
    toastr.error("đồ thị hiện tạikhông thểghi vào，Vui lòng thử lại sau", "ST-BME");
    return false;
  }

  const result = _actionHandlers.saveGraphNode?.({
    nodeId,
    updates,
  });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found"
        ? "Nút không còn tồn tại, vui lòng đóng rồi thử lại"
        : "Lưu thất bại",
      "ST-BME",
    );
    return false;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "Nội dung đã cập nhật, nhưng việc ghi ngược vào chat metadata có thể bị chặn; vui lòng xem trạng thái đồ thị",
      "ST-BME",
    );
  } else {
    toastr.success("Đã lưu nút", "ST-BME");
  }

  afterSuccess?.();
  refreshLiveState();
  return true;
}

function _deleteGraphNodeById(nodeId, { afterSuccess } = {}) {
  if (!nodeId) return false;
  if (_isGraphWriteBlocked()) {
    toastr.error("đồ thị hiện tạikhông thểghi vào，Vui lòng thử lại sau", "ST-BME");
    return false;
  }

  const g = _getGraph?.();
  const node = g?.nodes?.find((n) => n.id === nodeId);
  const label = node ? getNodeDisplayName(node) : nodeId;
  if (
    !confirm(
      `Xác nhận xóa nút "${label}"?\n\nNếu nút này có nút con phân tầng thì chúng cũng sẽ bị xóa theo. Thao tác này không thể hoàn tác ngay trong bảng này.`,
    )
  ) {
    return false;
  }

  const result = _actionHandlers.deleteGraphNode?.({ nodeId });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found" ? "Nút không còn tồn tại" : "Xóa thất bại",
      "ST-BME",
    );
    return false;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "Nút đã bị loại khỏi đồ thị, nhưng việc ghi ngược có thể bị chặn; vui lòng xem trạng thái đồ thị",
      "ST-BME",
    );
  } else {
    toastr.success("Đã xóa nút", "ST-BME");
  }

  afterSuccess?.();
  refreshLiveState();
  return true;
}

function _useMobileGraphNodeDetail() {
  return _isMobile() && currentTabId === "graph";
}

function _getNodeDetailEls() {
  const mobile = _useMobileGraphNodeDetail();
  const detailEl = document.getElementById(
    mobile ? "bme-mobile-node-detail" : "bme-node-detail",
  );
  const titleEl = document.getElementById(
    mobile ? "bme-mobile-detail-title" : "bme-detail-title",
  );
  const bodyEl = document.getElementById(
    mobile ? "bme-mobile-detail-body" : "bme-detail-body",
  );
  const scrimEl = mobile
    ? document.getElementById("bme-mobile-node-detail-scrim")
    : null;
  if (!detailEl || !titleEl || !bodyEl) return null;
  return { detailEl, titleEl, bodyEl, scrimEl, mobile };
}

function _closeNodeDetailUi() {
  document.getElementById("bme-node-detail")?.classList.remove("open");
  document.getElementById("bme-mobile-node-detail")?.classList.remove("open");
  document.getElementById("bme-mobile-node-detail-scrim")?.setAttribute("hidden", "");
}

function _showNodeDetail(node) {
  const els = _getNodeDetailEls();
  if (!els) return;
  const { detailEl, titleEl, bodyEl, scrimEl, mobile } = els;

  if (mobile) {
    document.getElementById("bme-node-detail")?.classList.remove("open");
  } else {
    document.getElementById("bme-mobile-node-detail")?.classList.remove("open");
    document.getElementById("bme-mobile-node-detail-scrim")?.setAttribute("hidden", "");
  }

  const raw = node.raw || node;
  titleEl.textContent = getNodeDisplayName(raw);
  detailEl.dataset.editNodeId = raw.id || "";
  bodyEl.replaceChildren(_buildNodeDetailEditorFragment(raw));

  if (mobile) {
    scrimEl?.removeAttribute("hidden");
  }
  detailEl.classList.add("open");
}

function _saveNodeDetail() {
  const els = _getNodeDetailEls();
  const detailEl = els?.detailEl;
  const bodyEl = els?.bodyEl;
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId || !bodyEl) return;
  const collected = _collectNodeDetailEditorUpdates(bodyEl);
  if (!collected.ok) {
    toastr.error(collected.errorMessage || "Lưu thất bại", "ST-BME");
    return;
  }

  _persistNodeDetailEdits(nodeId, collected.updates, {
    afterSuccess: () => {
      const r = _getActiveGraphRenderer();
      const sel = r?.selectedNode;
      if (sel?.id === nodeId && sel.raw) {
        _showNodeDetail(sel);
      } else {
        const g = _getGraph?.();
        const rawN = g?.nodes?.find((n) => n.id === nodeId);
        if (rawN) {
          _showNodeDetail({ raw: rawN, id: rawN.id });
        }
      }
    },
  });
}

function _bindNodeDetailPanel() {
  const saveBtn = document.getElementById("bme-detail-save");
  if (saveBtn && saveBtn.dataset.bmeBound !== "true") {
    saveBtn.addEventListener("click", () => _saveNodeDetail());
    saveBtn.dataset.bmeBound = "true";
  }
  const deleteBtn = document.getElementById("bme-detail-delete");
  if (deleteBtn && deleteBtn.dataset.bmeBound !== "true") {
    deleteBtn.addEventListener("click", () => _deleteNodeDetail());
    deleteBtn.dataset.bmeBound = "true";
  }
  const saveMob = document.getElementById("bme-mobile-detail-save");
  if (saveMob && saveMob.dataset.bmeBound !== "true") {
    saveMob.addEventListener("click", () => _saveNodeDetail());
    saveMob.dataset.bmeBound = "true";
  }
  const delMob = document.getElementById("bme-mobile-detail-delete");
  if (delMob && delMob.dataset.bmeBound !== "true") {
    delMob.addEventListener("click", () => _deleteNodeDetail());
    delMob.dataset.bmeBound = "true";
  }
}

function _deleteNodeDetail() {
  const els = _getNodeDetailEls();
  const detailEl = els?.detailEl;
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId) return;

  _deleteGraphNodeById(nodeId, {
    afterSuccess: () => {
      _closeNodeDetailUi();
      const dDesk = document.getElementById("bme-node-detail");
      const dMob = document.getElementById("bme-mobile-node-detail");
      if (dDesk) delete dDesk.dataset.editNodeId;
      if (dMob) delete dMob.dataset.editNodeId;
      graphRenderer?.highlightNode?.("__cleared__");
      mobileGraphRenderer?.highlightNode?.("__cleared__");
    },
  });
}

function _bindClose() {
  document
    .getElementById("bme-panel-close")
    ?.addEventListener("click", closePanel);
  document.getElementById("bme-detail-close")?.addEventListener("click", () => {
    _closeNodeDetailUi();
  });
  document.getElementById("bme-mobile-detail-close")?.addEventListener("click", () => {
    _closeNodeDetailUi();
  });
  document.getElementById("bme-mobile-node-detail-scrim")?.addEventListener("click", () => {
    _closeNodeDetailUi();
  });
  overlayEl?.addEventListener("click", (event) => {
    if (event.target === overlayEl) closePanel();
  });
}

function _bindResizeHandle() {
  const handle = document.getElementById("bme-resize-handle");
  const sidebar = panelEl?.querySelector(".bme-panel-sidebar");
  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(180, Math.min(600, startWidth + delta));
    sidebar.style.width = newWidth + "px";
    sidebar.style.minWidth = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

const PANEL_SIZE_KEY = "st-bme-panel-size";
let _panelResizeTimer = null;

function _bindPanelResize() {
  if (!panelEl || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    clearTimeout(_panelResizeTimer);
    _panelResizeTimer = setTimeout(() => {
      if (!overlayEl?.classList.contains("active")) return;
      const w = panelEl.offsetWidth;
      const h = panelEl.offsetHeight;
      if (w > 0 && h > 0) {
        try {
          localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w, h }));
        } catch { /* ignore */ }
      }
    }, 300);
  });
  observer.observe(panelEl);
}

function _restorePanelSize() {
  if (!panelEl) return;
  if (_isMobile()) {
    panelEl.style.width = "";
    panelEl.style.height = "";
    return;
  }
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return;
    const { w, h } = JSON.parse(raw);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 200 && h > 200) {
      panelEl.style.width = w + "px";
      panelEl.style.height = h + "px";
    }
  } catch { /* ignore */ }
}

async function _runCognitionNodeOverrideAction(mode = "") {
  const graph = _getGraph?.();
  const ownerEntries = _getCognitionOwnerCollection(graph);
  const ownerEntry =
    ownerEntries.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const selectedNode = _getSelectedGraphNode(graph);

  if (!ownerEntry) {
    toastr.info("Hãy chọn một nhân vật trước, rồi mới cài đặt bao phủ nhận thức", "ST-BME");
    return;
  }
  if (!selectedNode?.id) {
    toastr.info("Hãy chọn một nút trong đồ thị hoặc danh sách ký ức trước", "ST-BME");
    return;
  }

  let result = null;
  if (mode === "clear") {
    result = await _actionHandlers.clearKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
    });
  } else {
    result = await _actionHandlers.applyKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
      mode,
    });
  }

  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "Đồ thị hiện tại vẫn đang trong giai đoạn bảo vệ ghi, vui lòng thử lại sau",
      "node-not-found": "Nút này không còn tồn tại nữa, vui lòng chọn lại",
      "owner-not-found": "Không tìm thấy trạng thái nhận thức của nhân vật này, hãy để cô ấy tham gia một vòng trích xuất trước",
    };
    toastr.error(messageMap[result?.error] || "nhận thứcbao phủThất bại", "ST-BME");
    return;
  }

  const successMap = {
    known: "Đã đánh dấu là Cưỡng chế đã biết",
    hidden: "Đã đánh dấu là Cưỡng chế ẩn",
    mistaken: "Đã đánh dấu là Hiểu sai",
    clear: "Đã xóa bao phủ thủ công của nút này",
  };
  if (result.persistBlocked) {
    toastr.warning(
      `${successMap[mode] || "Bao phủ nhận thức đã cập nhật"}, nhưng việc ghi ngược chính thức có thể vẫn đang chờ đồ thị sẵn sàng`,
      "ST-BME",
    );
  } else {
    toastr.success(successMap[mode] || "Bao phủ nhận thức đã cập nhật", "ST-BME");
  }
  _refreshDashboard();
}

async function _applyManualActiveRegionFromDashboard(clear = false) {
  const input = document.getElementById("bme-cognition-manual-region");
  const region = clear ? "" : String(input?.value || "").trim();
  const result = await _actionHandlers.setActiveRegion?.({ region });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "Đồ thị vẫn đang ở giai đoạn bảo vệ ghi, tạm thời không thể sửa khu vực",
      "missing-graph": "Hiện không códùng đượcđồ thị",
    };
    toastr.error(messageMap[result?.error] || "Cập nhậtKhu vực hiện tạiThất bại", "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning(
      clear ? "Đã khôi phục khu vực tự động, nhưng ghi ngược chính thức vẫn đang chờ đồ thị sẵn sàng" : "Khu vực hiện tại đã cập nhật, nhưng ghi ngược chính thức vẫn đang chờ đồ thị sẵn sàng",
      "ST-BME",
    );
  } else {
    toastr.success(clear ? "Đã khôi phục phán định khu vực tự động" : "Khu vực hiện tạiĐã cập nhật", "ST-BME");
  }
  _refreshDashboard();
}

async function _saveRegionAdjacencyFromDashboard() {
  const graph = _getGraph?.();
  const regionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  const historyState = graph?.historyState || {};
  const region = String(
    regionInput?.value ||
      historyState.activeRegion ||
      graph?.regionState?.manualActiveRegion ||
      "",
  ).trim();
  const adjacent = String(adjacencyInput?.value || "")
    .split(/[,\n，]/)
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!region) {
    toastr.info("Hãy điền khu vực hiện tại trước, rồi lưu quan hệ kề cận", "ST-BME");
    return;
  }

  const result = await _actionHandlers.updateRegionAdjacency?.({
    region,
    adjacent,
  });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "Đồ thị vẫn đang trong giai đoạn bảo vệ ghi, tạm thời không thể sửa quan hệ kề cận",
      "missing-region": "Thiếu tên khu vực, không thể lưu quan hệ kề cận",
    };
    toastr.error(messageMap[result?.error] || "Lưukhu vựckề cậnThất bại", "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning("Quan hệ kề cận đã cập nhật, nhưng ghi ngược chính thức vẫn đang chờ đồ thị sẵn sàng", "ST-BME");
  } else {
    toastr.success("Đã lưu khu vực kề của khu vực hiện tại", "ST-BME");
  }
  _refreshDashboard();
}

function _bindDashboardControls() {
  const ownerList = document.getElementById("bme-cognition-owner-list");
  if (ownerList && ownerList.dataset.bmeBound !== "true") {
    ownerList.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-owner-key]");
      if (!button) return;
      const ownerKey = String(button.dataset.ownerKey || "").trim();
      if (!ownerKey) return;
      currentCognitionOwnerKey = ownerKey;
      _refreshDashboard();
    });
    ownerList.dataset.bmeBound = "true";
  }

  const detail = document.getElementById("bme-cognition-detail");
  if (detail && detail.dataset.bmeBound !== "true") {
    detail.addEventListener("click", async (event) => {
      const button = event.target.closest?.("[data-bme-cognition-node-action]");
      if (!button || button.disabled) return;
      await _runCognitionNodeOverrideAction(
        String(button.dataset.bmeCognitionNodeAction || ""),
      );
    });
    detail.dataset.bmeBound = "true";
  }

  const regionApply = document.getElementById("bme-cognition-region-apply");
  if (regionApply && regionApply.dataset.bmeBound !== "true") {
    regionApply.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(false);
    });
    regionApply.dataset.bmeBound = "true";
  }

  const regionClear = document.getElementById("bme-cognition-region-clear");
  if (regionClear && regionClear.dataset.bmeBound !== "true") {
    regionClear.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(true);
    });
    regionClear.dataset.bmeBound = "true";
  }

  const adjacencySave = document.getElementById("bme-cognition-adjacency-save");
  if (adjacencySave && adjacencySave.dataset.bmeBound !== "true") {
    adjacencySave.addEventListener("click", async () => {
      await _saveRegionAdjacencyFromDashboard();
    });
    adjacencySave.dataset.bmeBound = "true";
  }
}

// ==================== Thao tácgắn ====================

function _bindActions() {
  const bindings = {
    "bme-act-compress": "compress",
    "bme-act-sleep": "sleep",
    "bme-act-synopsis": "synopsis",
    "bme-act-summary-rollup": "summaryRollup",
    "bme-act-retry-persist": "retryPendingPersist",
    "bme-act-probe-graph-load": "probeGraphLoad",
    "bme-act-rebuild-luker-cache": "rebuildLukerLocalCache",
    "bme-act-repair-luker-sidecar": "repairLukerSidecar",
    "bme-act-compact-luker-sidecar": "compactLukerSidecar",
    "bme-act-export": "export",
    "bme-act-import": "import",
    "bme-act-rebuild": "rebuild",
    "bme-act-evolve": "evolve",
    "bme-act-undo-maintenance": "undoMaintenance",
    "bme-act-vector-rebuild": "rebuildVectorIndex",
    "bme-act-vector-reembed": "reembedDirect",
    "bme-act-clear-graph": "clearGraph",
    "bme-act-clear-vector-cache": "clearVectorCache",
    "bme-act-clear-batch-journal": "clearBatchJournal",
    "bme-act-delete-current-idb": "deleteCurrentIdb",
    "bme-act-delete-all-idb": "deleteAllIdb",
    "bme-act-delete-server-sync": "deleteServerSyncFile",
    "bme-act-backup-to-cloud": "backupToCloud",
    "bme-act-restore-from-cloud": "restoreFromCloud",
    "bme-act-manage-server-backups": "manageServerBackups",
    "bme-act-rollback-last-restore": "rollbackLastRestore",
  };

  const actionLabels = {
    compress: "Nén thủ công",
    sleep: "Thực hiện lãng quên",
    synopsis: "Tạo tóm tắt ngắn",
    summaryRollup: "Thực hiện gộp tóm tắt",
    retryPendingPersist: "Thử lưu bền lại",
    probeGraphLoad: "Thăm dò lại đồ thị",
    rebuildLukerLocalCache: "Xây lại bộ đệm cục bộ",
    repairLukerSidecar: "Sửa Sidecar chính",
    compactLukerSidecar: "Nén gọn Sidecar chính",
    rebuildSummaryState: "Xây lại trạng thái tóm tắt",
    export: "Xuất đồ thị",
    import: "Nhập đồ thị",
    rebuild: "Xây lại đồ thị",
    evolve: "Tiến hóa cưỡng bức",
    undoMaintenance: "Hoàn tác lần bảo trì gần nhất",
    rebuildVectorIndex: "Xây lại vector",
    reembedDirect: "Nhúng lại trực tiếp",
    clearGraph: "xóa sạchđồ thị",
    clearVectorCache: "Xóa bộ đệm vector",
    clearBatchJournal: "Xóa lịch sử trích xuất",
    deleteCurrentIdb: "xóa sạchhiện tạiCục bộlưu trữ",
    deleteAllIdb: "xóa sạchTất cảCục bộlưu trữ",
    deleteServerSyncFile: "Xóa dữ liệu đồng bộ máy chủ",
    backupToCloud: "\u5907\u4efd\u5230\u4e91\u7aef",
    restoreFromCloud: "\u4ece\u4e91\u7aef\u83b7\u53d6\u5907\u4efd",
    manageServerBackups: "\u7ba1\u7406\u670d\u52a1\u5668\u5907\u4efd",
    rollbackLastRestore: "\u56de\u6eda\u4e0a\u6b21\u6062\u590d",
  };

  const manualCloudFabBehaviors = {
    backupToCloud: {
      successStatus: "cloud-success",
      successTooltip: "Sao lưu đám mây hoàn tất",
      errorTooltip: "Sao lưu lên đám mâyThất bại",
    },
    restoreFromCloud: {
      successStatus: "cloud-success",
      successTooltip: "Đã lấy bản sao lưu từ đám mây",
      errorTooltip: "Lấy bản sao lưu từ đám mâyThất bại",
    },
    manageServerBackups: {
      suppressFab: true,
    },
    rollbackLastRestore: {
      successStatus: "cloud-success",
      successTooltip: "hoàn tácHoàn tất",
      errorTooltip: "Hoàn tác lần khôi phục trướcThất bại",
    },
  };

  for (const [elementId, actionKey] of Object.entries(bindings)) {
    const btn = document.getElementById(elementId);
    if (!btn) continue;

    btn.addEventListener("click", async () => {
      const handler =
        actionKey === "manageServerBackups"
          ? _openServerBackupManagerModal
          : _actionHandlers[actionKey];
      if (!handler) return;

      const label = actionLabels[actionKey] || actionKey;
      const fabBehavior = manualCloudFabBehaviors[actionKey] || null;
      const suppressFab = fabBehavior?.suppressFab === true;

      // Ngăn nhấn trùng lặp
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = "0.5";

      _showActionProgressUi(label);
      if (suppressFab) {
        _syncFloatingBallWithRuntimeStatus();
      }
      toastr.info(`${label} đang diễn raTrung bình…`, "ST-BME", { timeOut: 2000 });

      try {
        const result = await handler();
        if (result?.cancelled) {
          if (!suppressFab) {
            _syncFloatingBallWithRuntimeStatus();
          }
          return;
        }
        if (!result?.skipDashboardRefresh) {
          _refreshDashboard();
          _refreshGraph();
          if (currentTabId === "task") {
            _refreshTaskMonitor();
          }
        }
        if (!result?.handledToast) {
          toastr.success(`${label} Hoàn tất`, "ST-BME");
        }
        if (fabBehavior?.successTooltip) {
          updateFloatingBallStatus(
            fabBehavior.successStatus || "success",
            fabBehavior.successTooltip,
          );
        }
        void _refreshCloudBackupManualUi();
      } catch (error) {
        console.error(`[ST-BME] Action ${actionKey} failed:`, error);
        if (!suppressFab) {
          updateFloatingBallStatus(
            fabBehavior?.errorStatus || "error",
            fabBehavior?.errorTooltip || `${label}Thất bại`,
          );
        }
        if (!error?._stBmeToastHandled) {
          toastr.error(`${label} Thất bại: ${error?.message || error}`, "ST-BME");
        }
      } finally {
        btn.disabled = false;
        btn.style.opacity = "";
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
        void _refreshCloudBackupManualUi();
      }
    });
  }

  document
    .getElementById("bme-act-extract")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-extract");
      if (btn?.disabled) return;
      const mode =
        String(
          document.getElementById("bme-extract-mode")?.value ||
            (_getSettings?.() || {}).extractActionMode ||
            "pending",
        )
          .trim()
          .toLowerCase() === "rerun"
          ? "rerun"
          : "pending";
      const startFloor = _parseOptionalInt(
        document.getElementById("bme-extract-start-floor")?.value,
      );
      const endFloor = _parseOptionalInt(
        document.getElementById("bme-extract-end-floor")?.value,
      );
      const desc =
        mode === "pending"
          ? "Trích xuất nội dung chưa xử lý"
          : Number.isFinite(startFloor) || Number.isFinite(endFloor)
            ? `trích xuất lạiPhạm vi ${Number.isFinite(startFloor) ? startFloor : "hiện tại"} ~ ${Number.isFinite(endFloor) ? endFloor : "mới nhất"}`
            : "hiện tạitrích xuất lại";

      if (!confirm(`Xác nhận thực thi chứ?\n\n${desc}`)) {
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("Trích xuất lại");
      try {
        await _actionHandlers.extractTask?.({
          mode,
          startFloor: Number.isFinite(startFloor) ? startFloor : undefined,
          endFloor: Number.isFinite(endFloor) ? endFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action extractTask failed:", error);
        toastr.error(`Trích xuất lạiThất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  document
    .getElementById("bme-act-vector-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-vector-range");
      if (btn?.disabled) return;
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("Xây lại theo phạm vi");
      toastr.info("Xây lại theo phạm vi đang diễn raTrung bình…", "ST-BME", { timeOut: 2000 });

      try {
        const start = _parseOptionalInt(
          document.getElementById("bme-range-start")?.value,
        );
        const end = _parseOptionalInt(
          document.getElementById("bme-range-end")?.value,
        );
        await _actionHandlers.rebuildVectorRange?.(
          Number.isFinite(start) && Number.isFinite(end)
            ? { start, end }
            : null,
        );
        _refreshDashboard();
        _refreshGraph();
        toastr.success("Xây lại theo phạm vi Hoàn tất", "ST-BME");
      } catch (error) {
        console.error("[ST-BME] Action rebuildVectorRange failed:", error);
        toastr.error(`Xây lại theo phạm vi Thất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  document
    .getElementById("bme-act-summary-rebuild")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-summary-rebuild");
      if (btn?.disabled) return;
      const startFloor = _parseOptionalInt(
        document.getElementById("bme-extract-start-floor")?.value,
      );
      const endFloor = _parseOptionalInt(
        document.getElementById("bme-extract-end-floor")?.value,
      );
      const desc = Number.isFinite(startFloor) || Number.isFinite(endFloor)
        ? `Xây lại trạng thái tóm tắt theo phạm vi ${Number.isFinite(startFloor) ? startFloor : "hiện tại"} ~ ${Number.isFinite(endFloor) ? endFloor : "mới nhất"}`
        : "Xây lại trạng thái tóm tắt theo phạm vi liên quan tới phần tóm tắt hiện tại";

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("Xây lại trạng thái tóm tắt");
      try {
        await _actionHandlers.rebuildSummaryState?.({
          startFloor: Number.isFinite(startFloor) ? startFloor : undefined,
          endFloor: Number.isFinite(endFloor) ? endFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action rebuildSummaryState failed:", error);
        toastr.error(`Xây lại trạng thái tóm tắtThất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // Dọn theo phạm vi tầng (cleanup)
  document
    .getElementById("bme-act-clear-graph-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-clear-graph-range");
      if (btn?.disabled) return;

      const startStr = document.getElementById("bme-cleanup-range-start")?.value;
      const endStr = document.getElementById("bme-cleanup-range-end")?.value;
      const startSeq = _parseOptionalInt(startStr);
      const endSeq = _parseOptionalInt(endStr);

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("Dọn theo phạm vi tầng");
      try {
        await _actionHandlers.clearGraphRange?.(
          Number.isFinite(startSeq) ? startSeq : null,
          Number.isFinite(endSeq) ? endSeq : null,
        );
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action clearGraphRange failed:", error);
        toastr.error(`Dọn theo phạm vi tầngThất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // ==================== AI Monitor Trace gộp ====================

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(".bme-ai-monitor-entry__toggle");
    if (!toggle) return;
    const entry = toggle.closest(".bme-ai-monitor-entry");
    if (entry) entry.classList.toggle("is-collapsed");
  });

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(
      ".bme-timeline-entry__toggle, .bme-timeline-entry__head",
    );
    if (!toggle) return;
    const entry = toggle.closest(".bme-timeline-entry");
    if (entry) entry.classList.toggle("is-collapsed");
  });

  // ==================== Chế độ nhận thứcgắn ====================

  // đồ thị/Chế độ nhận thức tab chuyển đổi
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchGraphView(tab.dataset.graphView);
    });
  });

  // Chuyển tab con của đồ thị trên thiết bị di động
  document.querySelectorAll(".bme-graph-subtab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchMobileGraphSubView(tab.dataset.mobileGraphView);
    });
  });

  // Điều khiển nổi của đồ thị trên thiết bị di động
  document.getElementById("bme-mobile-render-toggle")?.addEventListener("click", () => {
    _toggleGraphRenderingEnabled();
  });
  document.getElementById("bme-mobile-zoom-in")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.zoomIn?.();
  });
  document.getElementById("bme-mobile-zoom-out")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.zoomOut?.();
  });
  document.getElementById("bme-mobile-zoom-reset")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.resetView?.();
  });

  // Đồ thị toàn màn hình
  document.getElementById("bme-fs-close")?.addEventListener("click", _closeFullscreenGraph);

  // Nhấn danh sách nhân vật trong chế độ nhận thức (bản desktop)
  document.getElementById("bme-cog-owner-list")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-owner-key]");
    if (!card) return;
    currentCognitionOwnerKey = card.dataset.ownerKey;
    _refreshCognitionWorkspace();
  });

  // Chế độ nhận thứcNhân vậtdanh sáchnhấn（thiết bị di động）
  document.getElementById("bme-mobile-cog-owner-list")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-owner-key]");
    if (!card) return;
    currentCognitionOwnerKey = card.dataset.ownerKey;
    _refreshMobileCognitionFull();
  });

  // Dashboard chuyển sang chế độ nhận thức
  document.getElementById("bme-cognition-jump-to-view")?.addEventListener("click", () => {
    _switchTab("dashboard");
    _switchGraphView("cognition");
  });

  // Công cụ không gian của chế độ nhận thức (delegate)
  document.getElementById("bme-cognition-workspace")?.addEventListener("click", (e) => {
    const regionApply = e.target.closest("#bme-cog-region-apply");
    const regionClear = e.target.closest("#bme-cog-region-clear");
    const adjSave = e.target.closest("#bme-cog-adjacency-save");
    const storyApply = e.target.closest("#bme-cog-story-time-apply");
    const storyClear = e.target.closest("#bme-cog-story-time-clear");

    if (regionApply) {
      const manualRegion = document.getElementById("bme-cog-manual-region")?.value?.trim();
      if (manualRegion) _callAction("setActiveRegion", { region: manualRegion });
    }
    if (regionClear) {
      _callAction("setActiveRegion", { region: "" });
    }
    if (adjSave) {
      const adjInput = document.getElementById("bme-cog-adjacency-input")?.value?.trim() || "";
      const adjList = adjInput.split(/[,，\/\\]/).map((s) => s.trim()).filter(Boolean);
      const graph = _getGraph?.();
      const activeRegion = String(
        graph?.historyState?.activeRegion || graph?.historyState?.lastExtractedRegion || graph?.regionState?.manualActiveRegion || "",
      ).trim();
      if (activeRegion) _callAction("updateRegionAdjacency", { region: activeRegion, adjacent: adjList });
    }
    if (storyApply) {
      const storyLabel = document.getElementById("bme-cog-manual-story-time")?.value?.trim();
      if (storyLabel) _callAction("setActiveStoryTime", { label: storyLabel });
    }
    if (storyClear) {
      _callAction("clearActiveStoryTime", {});
    }

    // Nút bao phủ thủ công
    const actionBtn = e.target.closest("[data-bme-cognition-node-action]");
    if (actionBtn) {
      const mode = actionBtn.dataset.bmeCognitionNodeAction;
      if (!mode) return;
      const graph = _getGraph?.();
      const selectedNode = _getSelectedGraphNode(graph);
      if (!selectedNode) return;
      const { selectedOwner } = _getCurrentCognitionOwnerSummary(graph);
      if (!selectedOwner) return;

      if (mode === "clear") {
        _callAction("clearKnowledgeOverride", { nodeId: selectedNode.id, ownerKey: selectedOwner.ownerKey });
      } else {
        _callAction("applyKnowledgeOverride", {
          nodeId: selectedNode.id,
          ownerKey: selectedOwner.ownerKey,
          ownerType: selectedOwner.ownerType || "",
          ownerName: selectedOwner.ownerName || "",
          mode,
        });
      }
      _refreshCognitionWorkspace();
    }
  });

  document.getElementById("bme-summary-workspace")?.addEventListener("click", async (e) => {
    const generateBtn = e.target.closest("#bme-summary-generate");
    const rollupBtn = e.target.closest("#bme-summary-rollup");
    const rebuildBtn = e.target.closest("#bme-summary-rebuild");
    const actionMap = new Map([
      [generateBtn, "synopsis"],
      [rollupBtn, "summaryRollup"],
      [rebuildBtn, "rebuildSummaryState"],
    ]);
    const matched = [...actionMap.entries()].find(([element]) => Boolean(element));
    if (!matched) return;

    const [, actionKey] = matched;
    const handler = _actionHandlers[actionKey];
    if (!handler) return;

    try {
      await handler();
      _refreshDashboard();
      _refreshGraph();
      _refreshSummaryWorkspace();
      if (currentTabId === "task") _refreshTaskMonitor();
    } catch (error) {
      console.error(`[ST-BME] summary workspace action failed: ${actionKey}`, error);
      toastr.error(String(error?.message || error || "Thao tácThất bại"), "ST-BME");
    }
  });
}

function _refreshConfigTab() {
  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  const resolvedActiveLlmPreset = String(settings.llmActivePreset || "");
  _refreshPlannerLauncher();

  _setCheckboxValue("bme-setting-enabled", settings.enabled ?? true);
  _setCheckboxValue(
    "bme-setting-debug-logging-enabled",
    settings.debugLoggingEnabled ?? false,
  );
  _setCheckboxValue(
    "bme-setting-ai-monitor-enabled",
    settings.enableAiMonitor ?? true,
  );
  _setCheckboxValue(
    "bme-setting-hide-old-messages-enabled",
    settings.hideOldMessagesEnabled ?? false,
  );
  _setCheckboxValue(
    "bme-setting-recall-enabled",
    settings.recallEnabled ?? true,
  );
  _setCheckboxValue("bme-setting-recall-llm", settings.recallEnableLLM ?? true);
  _setCheckboxValue(
    "bme-setting-recall-vector-prefilter-enabled",
    settings.recallEnableVectorPrefilter ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-graph-diffusion-enabled",
    settings.recallEnableGraphDiffusion ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-multi-intent-enabled",
    settings.recallEnableMultiIntent ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-context-query-blend-enabled",
    settings.recallEnableContextQueryBlend ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-lexical-boost-enabled",
    settings.recallEnableLexicalBoost ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-temporal-links-enabled",
    settings.recallEnableTemporalLinks ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-diversity-enabled",
    settings.recallEnableDiversitySampling ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-cooccurrence-enabled",
    settings.recallEnableCooccurrenceBoost ?? false,
  );
  _setCheckboxValue(
    "bme-setting-recall-residual-enabled",
    settings.recallEnableResidualRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-scoped-memory-enabled",
    settings.enableScopedMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-pov-memory-enabled",
    settings.enablePovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-region-scoped-objective-enabled",
    settings.enableRegionScopedObjective ?? true,
  );
  _setCheckboxValue(
    "bme-setting-cognitive-memory-enabled",
    settings.enableCognitiveMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-spatial-adjacency-enabled",
    settings.enableSpatialAdjacency ?? true,
  );
  _setCheckboxValue(
    "bme-setting-enable-story-timeline",
    settings.enableStoryTimeline ?? true,
  );
  _setCheckboxValue(
    "bme-setting-story-time-soft-directing",
    settings.storyTimeSoftDirecting ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-story-time-label",
    settings.injectStoryTimeLabel ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-user-pov-memory",
    settings.injectUserPovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-objective-global-memory",
    settings.injectObjectiveGlobalMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-low-confidence-objective-memory",
    settings.injectLowConfidenceObjectiveMemory ?? false,
  );
  _setCheckboxValue(
    "bme-setting-consolidation-enabled",
    settings.enableConsolidation ?? true,
  );
  _setCheckboxValue(
    "bme-setting-synopsis-enabled",
    settings.enableHierarchicalSummary ?? settings.enableSynopsis ?? true,
  );
  _setCheckboxValue(
    "bme-setting-visibility-enabled",
    settings.enableVisibility ?? false,
  );
  _setCheckboxValue(
    "bme-setting-cross-recall-enabled",
    settings.enableCrossRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-smart-trigger-enabled",
    settings.enableSmartTrigger ?? false,
  );
  _setCheckboxValue(
    "bme-setting-sleep-cycle-enabled",
    settings.enableSleepCycle ?? false,
  );
  _setCheckboxValue(
    "bme-setting-auto-compression-enabled",
    settings.enableAutoCompression ?? true,
  );
  _setCheckboxValue(
    "bme-setting-prob-recall-enabled",
    settings.enableProbRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-reflection-enabled",
    settings.enableReflection ?? false,
  );
  _setInputValue(
    "bme-setting-recall-card-user-input-display-mode",
    settings.recallCardUserInputDisplayMode ?? "beautify_only",
  );
  _setInputValue(
    "bme-setting-notice-display-mode",
    settings.noticeDisplayMode ?? "normal",
  );
  _setInputValue(
    "bme-setting-cloud-storage-mode",
    settings.cloudStorageMode || "automatic",
  );
  _refreshCloudStorageModeUi(settings);
  _setInputValue(
    "bme-setting-wi-filter-mode",
    settings.worldInfoFilterMode || "default",
  );
  _setInputValue(
    "bme-setting-wi-filter-keywords",
    settings.worldInfoFilterCustomKeywords || "",
  );
  _setInputValue(
    "bme-extract-mode",
    settings.extractActionMode || "pending",
  );
  const wiFilterCustomSection = panelEl?.querySelector(
    "#bme-wi-filter-custom-section",
  );
  if (wiFilterCustomSection) {
    wiFilterCustomSection.style.display =
      (settings.worldInfoFilterMode || "default") === "custom" ? "" : "none";
  }

  _setInputValue("bme-setting-extract-every", settings.extractEvery ?? 1);
  _setInputValue(
    "bme-setting-hide-old-messages-keep-last-n",
    settings.hideOldMessagesKeepLastN ?? 12,
  );
  _setInputValue(
    "bme-setting-extract-context-turns",
    settings.extractContextTurns ?? 2,
  );
  _setCheckboxValue(
    "bme-setting-extract-auto-delay-latest-assistant",
    settings.extractAutoDelayLatestAssistant === true,
  );
  _setInputValue(
    "bme-setting-extract-recent-message-cap",
    settings.extractRecentMessageCap ?? 0,
  );
  _setInputValue(
    "bme-setting-extract-prompt-structured-mode",
    settings.extractPromptStructuredMode || "both",
  );
  _setInputValue(
    "bme-setting-extract-worldbook-mode",
    settings.extractWorldbookMode || "active",
  );
  _setCheckboxValue(
    "bme-setting-extract-include-summaries",
    settings.extractIncludeSummaries !== false,
  );
  _setCheckboxValue(
    "bme-setting-extract-include-story-time",
    settings.extractIncludeStoryTime !== false,
  );
  _setInputValue("bme-setting-recall-top-k", settings.recallTopK ?? 20);
  _setInputValue("bme-setting-recall-max-nodes", settings.recallMaxNodes ?? 12);
  _setInputValue(
    "bme-setting-recall-diffusion-top-k",
    settings.recallDiffusionTopK ?? 100,
  );
  _setInputValue(
    "bme-setting-recall-llm-candidate-pool",
    settings.recallLlmCandidatePool ?? 30,
  );
  _setInputValue(
    "bme-setting-recall-llm-context-messages",
    settings.recallLlmContextMessages ?? 4,
  );
  _setInputValue(
    "bme-setting-recall-multi-intent-max-segments",
    settings.recallMultiIntentMaxSegments ?? 4,
  );
  _setInputValue(
    "bme-setting-recall-context-assistant-weight",
    settings.recallContextAssistantWeight ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-context-previous-user-weight",
    settings.recallContextPreviousUserWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-lexical-weight",
    settings.recallLexicalWeight ?? 0.18,
  );
  _setInputValue(
    "bme-setting-recall-teleport-alpha",
    settings.recallTeleportAlpha ?? 0.15,
  );
  _setInputValue(
    "bme-setting-recall-temporal-link-strength",
    settings.recallTemporalLinkStrength ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-dpp-candidate-multiplier",
    settings.recallDppCandidateMultiplier ?? 3,
  );
  _setInputValue(
    "bme-setting-recall-dpp-quality-weight",
    settings.recallDppQualityWeight ?? 1.0,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-scale",
    settings.recallCooccurrenceScale ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-max-neighbors",
    settings.recallCooccurrenceMaxNeighbors ?? 10,
  );
  _setInputValue(
    "bme-setting-recall-residual-basis-max-nodes",
    settings.recallResidualBasisMaxNodes ?? 24,
  );
  _setInputValue(
    "bme-setting-recall-nmf-topics",
    settings.recallNmfTopics ?? 15,
  );
  _setInputValue(
    "bme-setting-recall-nmf-novelty-threshold",
    settings.recallNmfNoveltyThreshold ?? 0.4,
  );
  _setInputValue(
    "bme-setting-recall-residual-threshold",
    settings.recallResidualThreshold ?? 0.3,
  );
  _setInputValue(
    "bme-setting-recall-residual-top-k",
    settings.recallResidualTopK ?? 5,
  );
  _setInputValue(
    "bme-setting-recall-character-pov-weight",
    settings.recallCharacterPovWeight ?? 1.25,
  );
  _setInputValue(
    "bme-setting-recall-user-pov-weight",
    settings.recallUserPovWeight ?? 1.05,
  );
  _setInputValue(
    "bme-setting-recall-objective-current-region-weight",
    settings.recallObjectiveCurrentRegionWeight ?? 1.15,
  );
  _setInputValue(
    "bme-setting-recall-objective-adjacent-region-weight",
    settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
  );
  _setInputValue(
    "bme-setting-recall-objective-global-weight",
    settings.recallObjectiveGlobalWeight ?? 0.75,
  );
  _setInputValue("bme-setting-inject-depth", settings.injectDepth ?? 9999);
  _setCheckboxValue(
    "bme-setting-recall-use-authoritative-generation-input",
    settings.recallUseAuthoritativeGenerationInput === true,
  );
  _setInputValue("bme-setting-graph-weight", settings.graphWeight ?? 0.6);
  _setInputValue("bme-setting-vector-weight", settings.vectorWeight ?? 0.3);
  _setInputValue(
    "bme-setting-importance-weight",
    settings.importanceWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-consolidation-neighbor-count",
    settings.consolidationNeighborCount ?? 5,
  );
  _setInputValue(
    "bme-setting-consolidation-threshold",
    settings.consolidationThreshold ?? 0.85,
  );
  _setInputValue(
    "bme-setting-synopsis-every",
    settings.smallSummaryEveryNExtractions ?? settings.synopsisEveryN ?? 3,
  );
  _setInputValue(
    "bme-setting-trigger-patterns",
    settings.triggerPatterns || "",
  );
  _setInputValue(
    "bme-setting-smart-trigger-threshold",
    settings.smartTriggerThreshold ?? 2,
  );
  _setInputValue(
    "bme-setting-forget-threshold",
    settings.forgetThreshold ?? 0.5,
  );
  _setInputValue(
    "bme-setting-consolidation-auto-min-new-nodes",
    settings.consolidationAutoMinNewNodes ?? 2,
  );
  _setInputValue(
    "bme-setting-compression-every",
    settings.compressionEveryN ?? 10,
  );
  _setInputValue("bme-setting-sleep-every", settings.sleepEveryN ?? 10);
  _setInputValue(
    "bme-setting-prob-recall-chance",
    settings.probRecallChance ?? 0.15,
  );
  _setInputValue("bme-setting-reflect-every", settings.reflectEveryN ?? 10);

  _setInputValue("bme-setting-llm-url", settings.llmApiUrl || "");
  _setInputValue("bme-setting-llm-key", settings.llmApiKey || "");
  _setInputValue("bme-setting-llm-model", settings.llmModel || "");
  _refreshMemoryLlmProviderHelp(settings.llmApiUrl || "");
  _populateLlmPresetSelect(settings.llmPresets || {}, resolvedActiveLlmPreset);
  _syncLlmPresetControls(resolvedActiveLlmPreset);
  _setInputValue("bme-setting-timeout-ms", settings.timeoutMs ?? 300000);

  _setInputValue("bme-setting-embed-url", settings.embeddingApiUrl || "");
  _setInputValue(
    "bme-setting-embed-key",
    settings.embeddingApiKeyPool || settings.embeddingApiKey || "",
  );
  _setInputValue(
    "bme-setting-embed-model",
    settings.embeddingModel || "text-embedding-3-small",
  );
  _setInputValue(
    "bme-setting-embed-mode",
    settings.embeddingTransportMode || "direct",
  );
  _toggleEmbedFields(settings.embeddingTransportMode || "direct");
  _setInputValue(
    "bme-setting-embed-backend-source",
    settings.embeddingBackendSource || "openai",
  );
  _setInputValue(
    "bme-setting-embed-backend-model",
    settings.embeddingBackendModel ||
      getSuggestedBackendModel(settings.embeddingBackendSource || "openai"),
  );
  _setInputValue(
    "bme-setting-embed-backend-url",
    settings.embeddingBackendApiUrl || "",
  );
  _setCheckboxValue(
    "bme-setting-embed-auto-suffix",
    settings.embeddingAutoSuffix !== false,
  );

  _setInputValue(
    "bme-setting-extract-prompt",
    settings.extractPrompt || getDefaultPromptText("extract"),
  );
  _setInputValue(
    "bme-setting-recall-prompt",
    settings.recallPrompt || getDefaultPromptText("recall"),
  );
  _setInputValue(
    "bme-setting-consolidation-prompt",
    settings.consolidationPrompt || getDefaultPromptText("consolidation"),
  );
  _setInputValue(
    "bme-setting-compress-prompt",
    settings.compressPrompt || getDefaultPromptText("compress"),
  );
  _setInputValue(
    "bme-setting-synopsis-prompt",
    settings.synopsisPrompt || getDefaultPromptText("synopsis"),
  );
  _setInputValue(
    "bme-setting-reflection-prompt",
    settings.reflectionPrompt || getDefaultPromptText("reflection"),
  );

  _refreshFetchedModelSelects(settings);
  _refreshGuardedConfigStates(settings);
  _refreshStageCardStates(settings);
  _refreshPromptCardStates(settings);
  _refreshTaskProfileWorkspace(settings);
  _refreshMessageTraceWorkspace(settings);
  _highlightThemeChoice(settings.panelTheme || "crimson");
  _syncConfigSectionState();
}

function _bindConfigControls() {
  if (!panelEl || panelEl.dataset.bmeConfigBound === "true") return;

  _prepareEmbeddingApiKeyPoolUi();

  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    if (btn.dataset.bmeBound === "true") return;
    btn.addEventListener("click", () => {
      _switchConfigSection(btn.dataset.configSection || "api");
    });
    btn.dataset.bmeBound = "true";
  });

  bindCheckbox("bme-setting-enabled", (checked) => {
    _patchSettings({ enabled: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-debug-logging-enabled", (checked) => {
    _patchSettings({ debugLoggingEnabled: checked });
  });
  bindCheckbox("bme-setting-ai-monitor-enabled", (checked) => {
    _patchSettings({ enableAiMonitor: checked });
    _refreshDashboard();
  });
  bindCheckbox("bme-setting-hide-old-messages-enabled", (checked) => {
    _patchSettings({ hideOldMessagesEnabled: checked });
  });
  bindCheckbox("bme-setting-recall-enabled", (checked) => {
    _patchSettings({ recallEnabled: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-llm", (checked) => {
    _patchSettings({ recallEnableLLM: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-vector-prefilter-enabled", (checked) => {
    _patchSettings({ recallEnableVectorPrefilter: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-graph-diffusion-enabled", (checked) => {
    _patchSettings({ recallEnableGraphDiffusion: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-multi-intent-enabled", (checked) => {
    _patchSettings({ recallEnableMultiIntent: checked });
  });
  bindCheckbox("bme-setting-recall-context-query-blend-enabled", (checked) => {
    _patchSettings({ recallEnableContextQueryBlend: checked });
  });
  bindCheckbox("bme-setting-recall-lexical-boost-enabled", (checked) => {
    _patchSettings({ recallEnableLexicalBoost: checked });
  });
  bindCheckbox("bme-setting-recall-temporal-links-enabled", (checked) => {
    _patchSettings({ recallEnableTemporalLinks: checked });
  });
  bindCheckbox("bme-setting-recall-diversity-enabled", (checked) => {
    _patchSettings({ recallEnableDiversitySampling: checked });
  });
  bindCheckbox("bme-setting-recall-cooccurrence-enabled", (checked) => {
    _patchSettings({ recallEnableCooccurrenceBoost: checked });
  });
  bindCheckbox("bme-setting-recall-residual-enabled", (checked) => {
    _patchSettings({ recallEnableResidualRecall: checked });
  });
  bindCheckbox("bme-setting-scoped-memory-enabled", (checked) => {
    _patchSettings({ enableScopedMemory: checked });
  });
  bindCheckbox("bme-setting-pov-memory-enabled", (checked) => {
    _patchSettings({ enablePovMemory: checked });
  });
  bindCheckbox(
    "bme-setting-region-scoped-objective-enabled",
    (checked) => {
      _patchSettings({ enableRegionScopedObjective: checked });
    },
  );
  bindCheckbox("bme-setting-cognitive-memory-enabled", (checked) => {
    _patchSettings({ enableCognitiveMemory: checked });
  });
  bindCheckbox("bme-setting-spatial-adjacency-enabled", (checked) => {
    _patchSettings({ enableSpatialAdjacency: checked });
  });
  bindCheckbox("bme-setting-enable-story-timeline", (checked) => {
    _patchSettings({ enableStoryTimeline: checked });
  });
  bindCheckbox("bme-setting-story-time-soft-directing", (checked) => {
    _patchSettings({ storyTimeSoftDirecting: checked });
  });
  bindCheckbox("bme-setting-inject-story-time-label", (checked) => {
    _patchSettings({ injectStoryTimeLabel: checked });
  });
  bindCheckbox("bme-setting-inject-user-pov-memory", (checked) => {
    _patchSettings({ injectUserPovMemory: checked });
  });
  bindCheckbox("bme-setting-inject-objective-global-memory", (checked) => {
    _patchSettings({ injectObjectiveGlobalMemory: checked });
  });
  bindCheckbox("bme-setting-inject-low-confidence-objective-memory", (checked) => {
    _patchSettings({ injectLowConfidenceObjectiveMemory: checked });
  });
  bindCheckbox("bme-setting-consolidation-enabled", (checked) => {
    _patchSettings({ enableConsolidation: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-synopsis-enabled", (checked) => {
    _patchSettings({
      enableHierarchicalSummary: checked,
      enableSynopsis: checked,
    });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-visibility-enabled", (checked) =>
    _patchSettings({ enableVisibility: checked }),
  );
  bindCheckbox("bme-setting-cross-recall-enabled", (checked) =>
    _patchSettings({ enableCrossRecall: checked }),
  );
  bindCheckbox("bme-setting-smart-trigger-enabled", (checked) => {
    _patchSettings({ enableSmartTrigger: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-sleep-cycle-enabled", (checked) => {
    _patchSettings({ enableSleepCycle: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-auto-compression-enabled", (checked) => {
    _patchSettings({ enableAutoCompression: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-prob-recall-enabled", (checked) => {
    _patchSettings({ enableProbRecall: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-reflection-enabled", (checked) => {
    _patchSettings({ enableReflection: checked });
    _refreshGuardedConfigStates();
  });
  const recallCardUserInputDisplayModeEl = document.getElementById(
    "bme-setting-recall-card-user-input-display-mode",
  );
  if (
    recallCardUserInputDisplayModeEl &&
    recallCardUserInputDisplayModeEl.dataset.bmeBound !== "true"
  ) {
    recallCardUserInputDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        recallCardUserInputDisplayMode:
          recallCardUserInputDisplayModeEl.value || "beautify_only",
      });
    });
    recallCardUserInputDisplayModeEl.dataset.bmeBound = "true";
  }
  const noticeDisplayModeEl = document.getElementById(
    "bme-setting-notice-display-mode",
  );
  if (noticeDisplayModeEl && noticeDisplayModeEl.dataset.bmeBound !== "true") {
    noticeDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        noticeDisplayMode: noticeDisplayModeEl.value || "normal",
      });
    });
    noticeDisplayModeEl.dataset.bmeBound = "true";
  }
  const extractModeEl = document.getElementById("bme-extract-mode");
  if (extractModeEl && extractModeEl.dataset.bmeBound !== "true") {
    extractModeEl.addEventListener("change", () => {
      _patchSettings({
        extractActionMode:
          String(extractModeEl.value || "pending").trim().toLowerCase() ===
          "rerun"
            ? "rerun"
            : "pending",
      });
    });
    extractModeEl.dataset.bmeBound = "true";
  }
  const cloudStorageModeEl = document.getElementById(
    "bme-setting-cloud-storage-mode",
  );
  if (cloudStorageModeEl && cloudStorageModeEl.dataset.bmeBound !== "true") {
    cloudStorageModeEl.addEventListener("change", () => {
      const settings = _patchSettings({
        cloudStorageMode: cloudStorageModeEl.value || "automatic",
      });
      _refreshCloudStorageModeUi(settings);
    });
    cloudStorageModeEl.dataset.bmeBound = "true";
  }
  const wiFilterModeEl = document.getElementById("bme-setting-wi-filter-mode");
  if (wiFilterModeEl && wiFilterModeEl.dataset.bmeBound !== "true") {
    wiFilterModeEl.addEventListener("change", () => {
      const nextValue = wiFilterModeEl.value || "default";
      _patchSettings({ worldInfoFilterMode: nextValue });
      const section = panelEl?.querySelector("#bme-wi-filter-custom-section");
      if (section) {
        section.style.display = nextValue === "custom" ? "" : "none";
      }
    });
    wiFilterModeEl.dataset.bmeBound = "true";
  }
  const wiFilterKeywordsEl = document.getElementById(
    "bme-setting-wi-filter-keywords",
  );
  if (wiFilterKeywordsEl && wiFilterKeywordsEl.dataset.bmeBound !== "true") {
    wiFilterKeywordsEl.addEventListener("change", () => {
      _patchSettings({
        worldInfoFilterCustomKeywords: wiFilterKeywordsEl.value || "",
      });
    });
    wiFilterKeywordsEl.dataset.bmeBound = "true";
  }

  bindNumber("bme-setting-extract-every", 1, 1, 50, (value) =>
    _patchSettings({ extractEvery: value }),
  );
  bindNumber(
    "bme-setting-hide-old-messages-keep-last-n",
    12,
    0,
    200,
    (value) => _patchSettings({ hideOldMessagesKeepLastN: value }),
  );
  bindNumber("bme-setting-extract-context-turns", 2, 0, 20, (value) =>
    _patchSettings({ extractContextTurns: value }),
  );
  bindCheckbox(
    "bme-setting-extract-auto-delay-latest-assistant",
    (checked) =>
      _patchSettings({ extractAutoDelayLatestAssistant: checked }),
  );
  bindNumber("bme-setting-extract-recent-message-cap", 0, 0, 200, (value) =>
    _patchSettings({ extractRecentMessageCap: value }),
  );
  const extractStructuredModeEl = document.getElementById(
    "bme-setting-extract-prompt-structured-mode",
  );
  if (extractStructuredModeEl && extractStructuredModeEl.dataset.bmeBound !== "true") {
    extractStructuredModeEl.addEventListener("change", () => {
      _patchSettings({ extractPromptStructuredMode: extractStructuredModeEl.value || "both" });
    });
    extractStructuredModeEl.dataset.bmeBound = "true";
  }
  const extractWorldbookModeEl = document.getElementById(
    "bme-setting-extract-worldbook-mode",
  );
  if (extractWorldbookModeEl && extractWorldbookModeEl.dataset.bmeBound !== "true") {
    extractWorldbookModeEl.addEventListener("change", () => {
      _patchSettings({ extractWorldbookMode: extractWorldbookModeEl.value || "active" });
    });
    extractWorldbookModeEl.dataset.bmeBound = "true";
  }
  bindCheckbox(
    "bme-setting-extract-include-summaries",
    (checked) => _patchSettings({ extractIncludeSummaries: checked }),
  );
  bindCheckbox(
    "bme-setting-extract-include-story-time",
    (checked) => _patchSettings({ extractIncludeStoryTime: checked }),
  );
  bindNumber("bme-setting-recall-top-k", 20, 1, 100, (value) =>
    _patchSettings({ recallTopK: value }),
  );
  bindNumber("bme-setting-recall-max-nodes", 12, 1, 50, (value) =>
    _patchSettings({ recallMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-diffusion-top-k", 100, 1, 300, (value) =>
    _patchSettings({ recallDiffusionTopK: value }),
  );
  bindNumber("bme-setting-recall-llm-candidate-pool", 30, 1, 100, (value) =>
    _patchSettings({ recallLlmCandidatePool: value }),
  );
  bindNumber("bme-setting-recall-llm-context-messages", 4, 0, 20, (value) =>
    _patchSettings({ recallLlmContextMessages: value }),
  );
  bindNumber(
    "bme-setting-recall-multi-intent-max-segments",
    4,
    1,
    8,
    (value) => _patchSettings({ recallMultiIntentMaxSegments: value }),
  );
  bindFloat(
    "bme-setting-recall-context-assistant-weight",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallContextAssistantWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-context-previous-user-weight",
    0.1,
    0,
    1,
    (value) => _patchSettings({ recallContextPreviousUserWeight: value }),
  );
  bindFloat("bme-setting-recall-lexical-weight", 0.18, 0, 1, (value) =>
    _patchSettings({ recallLexicalWeight: value }),
  );
  bindFloat("bme-setting-recall-teleport-alpha", 0.15, 0, 1, (value) =>
    _patchSettings({ recallTeleportAlpha: value }),
  );
  bindFloat(
    "bme-setting-recall-temporal-link-strength",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallTemporalLinkStrength: value }),
  );
  bindNumber(
    "bme-setting-recall-dpp-candidate-multiplier",
    3,
    1,
    10,
    (value) => _patchSettings({ recallDppCandidateMultiplier: value }),
  );
  bindFloat("bme-setting-recall-dpp-quality-weight", 1.0, 0, 10, (value) =>
    _patchSettings({ recallDppQualityWeight: value }),
  );
  bindFloat("bme-setting-recall-cooccurrence-scale", 0.1, 0, 10, (value) =>
    _patchSettings({ recallCooccurrenceScale: value }),
  );
  bindNumber(
    "bme-setting-recall-cooccurrence-max-neighbors",
    10,
    1,
    50,
    (value) => _patchSettings({ recallCooccurrenceMaxNeighbors: value }),
  );
  bindNumber(
    "bme-setting-recall-residual-basis-max-nodes",
    24,
    2,
    64,
    (value) => _patchSettings({ recallResidualBasisMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-nmf-topics", 15, 2, 64, (value) =>
    _patchSettings({ recallNmfTopics: value }),
  );
  bindFloat(
    "bme-setting-recall-nmf-novelty-threshold",
    0.4,
    0,
    1,
    (value) => _patchSettings({ recallNmfNoveltyThreshold: value }),
  );
  bindFloat("bme-setting-recall-residual-threshold", 0.3, 0, 10, (value) =>
    _patchSettings({ recallResidualThreshold: value }),
  );
  bindNumber("bme-setting-recall-residual-top-k", 5, 1, 20, (value) =>
    _patchSettings({ recallResidualTopK: value }),
  );
  bindFloat("bme-setting-recall-character-pov-weight", 1.25, 0, 3, (value) =>
    _patchSettings({ recallCharacterPovWeight: value }),
  );
  bindFloat("bme-setting-recall-user-pov-weight", 1.05, 0, 3, (value) =>
    _patchSettings({ recallUserPovWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-current-region-weight",
    1.15,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveCurrentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-adjacent-region-weight",
    0.9,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveAdjacentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-global-weight",
    0.75,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveGlobalWeight: value }),
  );
  bindNumber("bme-setting-inject-depth", 9999, 0, 9999, (value) =>
    _patchSettings({ injectDepth: value }),
  );
  bindCheckbox(
    "bme-setting-recall-use-authoritative-generation-input",
    (checked) =>
      _patchSettings({ recallUseAuthoritativeGenerationInput: checked }),
  );
  bindFloat("bme-setting-graph-weight", 0.6, 0, 1, (value) =>
    _patchSettings({ graphWeight: value }),
  );
  bindFloat("bme-setting-vector-weight", 0.3, 0, 1, (value) =>
    _patchSettings({ vectorWeight: value }),
  );
  bindFloat("bme-setting-importance-weight", 0.1, 0, 1, (value) =>
    _patchSettings({ importanceWeight: value }),
  );
  bindNumber("bme-setting-consolidation-neighbor-count", 5, 1, 20, (value) =>
    _patchSettings({ consolidationNeighborCount: value }),
  );
  bindFloat("bme-setting-consolidation-threshold", 0.85, 0.5, 0.99, (value) =>
    _patchSettings({ consolidationThreshold: value }),
  );
  bindNumber("bme-setting-synopsis-every", 3, 1, 100, (value) =>
    _patchSettings({
      smallSummaryEveryNExtractions: value,
      synopsisEveryN: value,
    }),
  );
  bindText("bme-setting-trigger-patterns", (value) =>
    _patchSettings({ triggerPatterns: value }),
  );
  bindNumber("bme-setting-smart-trigger-threshold", 2, 1, 10, (value) =>
    _patchSettings({ smartTriggerThreshold: value }),
  );
  bindFloat("bme-setting-forget-threshold", 0.5, 0.1, 1, (value) =>
    _patchSettings({ forgetThreshold: value }),
  );
  bindNumber(
    "bme-setting-consolidation-auto-min-new-nodes",
    2,
    1,
    50,
    (value) => _patchSettings({ consolidationAutoMinNewNodes: value }),
  );
  bindNumber(
    "bme-setting-compression-every",
    10,
    0,
    500,
    (value) => _patchSettings({ compressionEveryN: value }),
  );
  bindNumber("bme-setting-sleep-every", 10, 1, 200, (value) =>
    _patchSettings({ sleepEveryN: value }),
  );
  bindFloat("bme-setting-prob-recall-chance", 0.15, 0.01, 0.5, (value) =>
    _patchSettings({ probRecallChance: value }),
  );
  bindNumber("bme-setting-reflect-every", 10, 1, 200, (value) =>
    _patchSettings({ reflectEveryN: value }),
  );

  const llmPresetSelect = document.getElementById("bme-llm-preset-select");
  if (llmPresetSelect && llmPresetSelect.dataset.bmeBound !== "true") {
    llmPresetSelect.addEventListener("change", () => {
      const selectedName = String(llmPresetSelect.value || "");
      if (!selectedName) {
        const currentActivePreset = String(
          (_getSettings?.() || {}).llmActivePreset || "",
        );
        if (currentActivePreset) {
          _patchSettings({ llmActivePreset: "" });
        }
        _syncLlmPresetControls("");
        return;
      }

      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const preset = settings.llmPresets?.[selectedName];
      if (!preset) {
        _patchSettings({ llmActivePreset: "" }, { refreshTaskWorkspace: true });
        _populateLlmPresetSelect(settings.llmPresets || {}, "");
        _syncLlmPresetControls("");
        toastr.warning("Mẫu đã chọn không tồn tại, đã chuyển về chế độ thủ công", "ST-BME");
        return;
      }

      _patchSettings({
        llmApiUrl: preset.llmApiUrl,
        llmApiKey: preset.llmApiKey,
        llmModel: preset.llmModel,
        llmActivePreset: selectedName,
      });
      _setInputValue("bme-setting-llm-url", preset.llmApiUrl);
      _setInputValue("bme-setting-llm-key", preset.llmApiKey);
      _setInputValue("bme-setting-llm-model", preset.llmModel);
      _refreshMemoryLlmProviderHelp(preset.llmApiUrl);
      _clearFetchedLlmModels();
      _syncLlmPresetControls(selectedName);
    });
    llmPresetSelect.dataset.bmeBound = "true";
  }

  const llmPresetSaveBtn = document.getElementById("bme-llm-preset-save");
  if (llmPresetSaveBtn && llmPresetSaveBtn.dataset.bmeBound !== "true") {
    llmPresetSaveBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        document.getElementById("bme-llm-preset-save-as")?.click();
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [activePreset]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({ llmPresets: nextPresets }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, activePreset);
      _syncLlmPresetControls(activePreset);
      toastr.success("Đã lưu mẫu hiện tại", "ST-BME");
    });
    llmPresetSaveBtn.dataset.bmeBound = "true";
  }

  const llmPresetSaveAsBtn = document.getElementById("bme-llm-preset-save-as");
  if (llmPresetSaveAsBtn && llmPresetSaveAsBtn.dataset.bmeBound !== "true") {
    llmPresetSaveAsBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      const suggestedName = activePreset
        ? `${activePreset} bản sao`
        : "Mẫu mới";
      const nextName = window.prompt("Vui lòng nhập tên mẫu mới", suggestedName);
      if (nextName == null) return;

      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("mẫuTênkhông thểtrống", "ST-BME");
        return;
      }
      if (trimmedName in (settings.llmPresets || {})) {
        toastr.info("Tên mẫu đã tồn tại, vui lòng đổi tên khác", "ST-BME");
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [trimmedName]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: trimmedName,
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, trimmedName);
      _syncLlmPresetControls(trimmedName);
      toastr.success("Đã lưu thành mẫu mới", "ST-BME");
    });
    llmPresetSaveAsBtn.dataset.bmeBound = "true";
  }

  const llmPresetDeleteBtn = document.getElementById("bme-llm-preset-delete");
  if (llmPresetDeleteBtn && llmPresetDeleteBtn.dataset.bmeBound !== "true") {
    llmPresetDeleteBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        toastr.info("Hiện đang ở chế độ thủ công, không có mẫu nào để xóa", "ST-BME");
        return;
      }

      const confirmed = window.confirm(
        `Xác nhận xóa preset "${activePreset}"? Giá trị hiện đang nằm trong ô nhập sẽ được giữ lại.`,
      );
      if (!confirmed) return;

      const nextPresets = { ...(settings.llmPresets || {}) };
      delete nextPresets[activePreset];
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: "",
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, "");
      _syncLlmPresetControls("");
      toastr.success("Đã xóa mẫu", "ST-BME");
    });
    llmPresetDeleteBtn.dataset.bmeBound = "true";
  }

  bindText("bme-setting-llm-url", (value) => {
    _patchSettings({ llmApiUrl: value.trim() });
    _refreshMemoryLlmProviderHelp(value);
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-key", (value) => {
    _patchSettings({ llmApiKey: value.trim() });
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-model", (value) => {
    _patchSettings({ llmModel: value.trim() });
    _markLlmPresetDirty();
  });
  bindNumber("bme-setting-timeout-ms", 300000, 1000, 3600000, (value) =>
    _patchSettings({ timeoutMs: value }),
  );

  bindText("bme-setting-embed-url", (value) =>
    _patchSettings({ embeddingApiUrl: value.trim() }),
  );
  bindText("bme-setting-embed-key", (value) => {
    const normalizedPool = _normalizeEmbeddingApiKeyPoolText(value);
    _patchSettings({
      embeddingApiKeyPool: normalizedPool,
      embeddingApiKey: _getPrimaryEmbeddingApiKeyFromPoolText(normalizedPool),
    });
  });
  bindText("bme-setting-embed-model", (value) =>
    _patchSettings({ embeddingModel: value.trim() }),
  );
  bindText("bme-setting-embed-mode", (value) => {
    _patchSettings({ embeddingTransportMode: value });
    _toggleEmbedFields(value);
  });
  bindText("bme-setting-embed-backend-source", (value) => {
    const settings = _getSettings?.() || {};
    const patch = { embeddingBackendSource: value };
    const suggestedModel = getSuggestedBackendModel(value);
    if (
      !settings.embeddingBackendModel ||
      settings.embeddingBackendModel ===
        getSuggestedBackendModel(settings.embeddingBackendSource || "openai")
    ) {
      patch.embeddingBackendModel = suggestedModel;
    }
    _patchSettings(patch);
    _setInputValue(
      "bme-setting-embed-backend-model",
      patch.embeddingBackendModel || settings.embeddingBackendModel || "",
    );
  });
  bindText("bme-setting-embed-backend-model", (value) =>
    _patchSettings({ embeddingBackendModel: value.trim() }),
  );
  bindText("bme-setting-embed-backend-url", (value) =>
    _patchSettings({ embeddingBackendApiUrl: value.trim() }),
  );
  bindCheckbox("bme-setting-embed-auto-suffix", (checked) =>
    _patchSettings({ embeddingAutoSuffix: checked }),
  );

  bindPromptText("bme-setting-extract-prompt", "extractPrompt", "extract");
  bindPromptText("bme-setting-recall-prompt", "recallPrompt", "recall");
  bindPromptText(
    "bme-setting-consolidation-prompt",
    "consolidationPrompt",
    "consolidation",
  );
  bindPromptText("bme-setting-compress-prompt", "compressPrompt", "compress");
  bindPromptText("bme-setting-synopsis-prompt", "synopsisPrompt", "synopsis");
  bindPromptText(
    "bme-setting-reflection-prompt",
    "reflectionPrompt",
    "reflection",
  );
  _bindTaskProfileWorkspace();

  panelEl.querySelectorAll(".bme-prompt-reset").forEach((button) => {
    if (button.dataset.bmeBound === "true") return;
    button.addEventListener("click", () => {
      const settingKey = button.dataset.settingKey;
      const promptKey = button.dataset.defaultPrompt;
      const targetId = button.dataset.targetId;
      if (!settingKey || !promptKey || !targetId) return;
      _patchSettings({ [settingKey]: "" }, { refreshPrompts: true });
      _setInputValue(targetId, getDefaultPromptText(promptKey));
      _refreshPromptCardStates();
    });
    button.dataset.bmeBound = "true";
  });

  const pickerBtn = document.getElementById("bme-theme-picker-btn");
  const dropdown = document.getElementById("bme-theme-dropdown");
  if (pickerBtn && dropdown) {
    pickerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    dropdown.querySelectorAll(".bme-theme-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const theme = opt.dataset.theme;
        if (!theme) return;
        _patchSettings({ panelTheme: theme }, { refreshTheme: true });
        dropdown.classList.remove("open");
      });
    });
    document.addEventListener("click", () => {
      dropdown.classList.remove("open");
    });
    dropdown.addEventListener("click", (e) => e.stopPropagation());
  }

  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    if (card.dataset.bmeBound === "true") return;
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      if (!theme) return;
      _patchSettings({ panelTheme: theme }, { refreshTheme: true });
    });
    card.dataset.bmeBound = "true";
  });

  document
    .getElementById("bme-apply-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.applyCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.success("Đã áp dụng lại cài đặt ẩn của chat hiện tại", "ST-BME");
    });
  document
    .getElementById("bme-clear-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.clearCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.info("Đã hủy phần ẩn do ST-BME áp dụng trong chat hiện tại", "ST-BME");
    });
  document
    .getElementById("bme-test-llm")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testMemoryLLM?.();
    });
  document
    .getElementById("bme-test-embedding")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testEmbedding?.();
    });
  document
    .getElementById("bme-fetch-llm-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchMemoryLLMModels?.();
      if (!result?.success) return;
      fetchedMemoryLLMModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-llm-model",
        fetchedMemoryLLMModels,
        (_getSettings?.() || {}).llmModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-backend-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("backend");
      if (!result?.success) return;
      fetchedBackendEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-backend-model",
        fetchedBackendEmbeddingModels,
        (_getSettings?.() || {}).embeddingBackendModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-direct-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("direct");
      if (!result?.success) return;
      fetchedDirectEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-direct-model",
        fetchedDirectEmbeddingModels,
        (_getSettings?.() || {}).embeddingModel || "",
      );
    });

  bindSelectModel("bme-select-llm-model", "bme-setting-llm-model", "llmModel");
  bindSelectModel(
    "bme-select-embed-backend-model",
    "bme-setting-embed-backend-model",
    "embeddingBackendModel",
  );
  bindSelectModel(
    "bme-select-embed-direct-model",
    "bme-setting-embed-model",
    "embeddingModel",
  );

  panelEl.dataset.bmeConfigBound = "true";
}

function bindText(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => onChange(element.value));
  element.addEventListener("change", () => onChange(element.value));
  element.dataset.bmeBound = "true";
}

function bindCheckbox(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => onChange(Boolean(element.checked)));
  element.dataset.bmeBound = "true";
}

function bindNumber(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseInt(element.value, 10);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindFloat(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseFloat(element.value);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindPromptText(id, settingKey, promptKey) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  const update = () => {
    _patchSettings({ [settingKey]: element.value }, { refreshPrompts: true });
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  element.addEventListener("blur", () => {
    if (!String(element.value || "").trim()) {
      _setInputValue(id, getDefaultPromptText(promptKey));
    }
  });
  element.dataset.bmeBound = "true";
}

function bindSelectModel(selectId, inputId, settingKey) {
  const element = document.getElementById(selectId);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => {
    if (!element.value) return;
    _setInputValue(inputId, element.value);
    _patchSettings({ [settingKey]: element.value });
  });
  element.dataset.bmeBound = "true";
}

function _bindTaskProfileWorkspace() {
  const workspace = document.getElementById("bme-task-profile-workspace");
  const importInput = document.getElementById("bme-task-profile-import");
  if (!workspace) return;

  if (workspace.dataset.bmeBound !== "true") {
    workspace.addEventListener("click", (event) => {
      void _handleTaskProfileWorkspaceClick(event);
    });
    workspace.addEventListener("input", (event) => {
      _handleTaskProfileWorkspaceInput(event);
    });
    workspace.addEventListener("change", (event) => {
      _handleTaskProfileWorkspaceChange(event);
    });
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-task-drag-handle");
      const row = target.closest(".bme-task-block-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const blockId = String(row.dataset.blockId || "").trim();
      if (!blockId) return;
      currentTaskProfileDragBlockId = blockId;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", blockId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragBlockId) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _setTaskBlockDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragBlockId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.blockId || "").trim();
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _clearTaskBlockDragIndicators(workspace);
      currentTaskProfileDragBlockId = "";
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderTaskBlocks(sourceId, targetId, position);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragBlockId = "";
      _clearTaskBlockDragIndicators(workspace);
    });
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-regex-drag-handle");
      const row = target.closest(".bme-regex-rule-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const ruleId = String(row.dataset.ruleId || "").trim();
      if (!ruleId) return;
      currentTaskProfileDragRuleId = ruleId;
      currentTaskProfileDragRuleIsGlobal = _isGlobalRegexPanelTarget(row);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", ruleId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragRuleId) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _setRegexRuleDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragRuleId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.ruleId || "").trim();
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _clearRegexRuleDragIndicators(workspace);
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderRegexRules(sourceId, targetId, position, isGlobalRow);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      _clearRegexRuleDragIndicators(workspace);
    });
    workspace.dataset.bmeBound = "true";
  }

  if (importInput && importInput.dataset.bmeBound !== "true") {
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const settings = _getSettings?.() || {};
        const parsed = JSON.parse(text);
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let imported = parseImportedTaskProfile(
          settings.taskProfiles || {},
          parsed,
        );
        const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
          nextGlobalTaskRegex,
          imported.profile,
          {
            applyLegacyConfig: !importedGlobalMerge.replacedConfig,
          },
        );
        nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
        if (legacyRuleMerge.clearedLegacyRules) {
          imported = {
            ...imported,
            profile: legacyRuleMerge.profile,
            taskProfiles: upsertTaskProfile(
              imported.taskProfiles,
              imported.taskType,
              legacyRuleMerge.profile,
              { setActive: true },
            ),
          };
        }
        currentTaskProfileTaskType = imported.taskType || currentTaskProfileTaskType;
        currentTaskProfileBlockId = imported.profile?.blocks?.[0]?.id || "";
        currentTaskProfileRuleId =
          imported.profile?.regex?.localRules?.[0]?.id || "";
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: imported.taskProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + legacyRuleMerge.mergedRuleCount;
        toastr.success(
          mergedRuleCount > 0
            ? `Nhập preset thành công, ${mergedRuleCount} quy tắc regex đã được hợp nhất vào quy tắc regex dùng chung`
            : "presetNhậpthành công",
          "ST-BME",
        );
      } catch (error) {
        console.error("[ST-BME] NhậpPreset tác vụThất bại:", error);
        toastr.error(`presetNhập thất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        importInput.value = "";
      }
    });
    importInput.dataset.bmeBound = "true";
  }

  const importAllInput = document.getElementById("bme-task-profile-import-all");
  if (importAllInput && importAllInput.dataset.bmeBound !== "true") {
    importAllInput.addEventListener("change", async () => {
      const file = importAllInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed?.format !== "st-bme-all-task-profiles" || !parsed?.profiles) {
          throw new Error("Định dạng tệp không đúng, vui lòng chọn tệp được tạo từ “Xuất tất cả”");
        }
        const settings = _getSettings?.() || {};
        let mergedProfiles = settings.taskProfiles || {};
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let importedCount = 0;
        let mergedLegacyRuleCount = 0;
        let legacyConfigImported = Boolean(importedGlobalMerge.replacedConfig);
        let skippedLegacyConfigCount = 0;
        for (const [taskType, entry] of Object.entries(parsed.profiles)) {
          try {
            let imported = parseImportedTaskProfile(
              mergedProfiles,
              entry,
              taskType,
            );
            const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
              nextGlobalTaskRegex,
              imported.profile,
              {
                applyLegacyConfig: !legacyConfigImported,
              },
            );
            nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
            mergedLegacyRuleCount += legacyRuleMerge.mergedRuleCount;
            if (legacyRuleMerge.appliedLegacyConfig) {
              legacyConfigImported = true;
            } else if (legacyRuleMerge.hasConfigDiff && legacyConfigImported) {
              skippedLegacyConfigCount += 1;
            }
            if (legacyRuleMerge.clearedLegacyRules) {
              imported = {
                ...imported,
                profile: legacyRuleMerge.profile,
                taskProfiles: upsertTaskProfile(
                  imported.taskProfiles,
                  imported.taskType,
                  legacyRuleMerge.profile,
                  { setActive: true },
                ),
              };
            }
            mergedProfiles = imported.taskProfiles;
            importedCount++;
          } catch (innerError) {
            console.warn(`[ST-BME] Bỏ quaNhậpTác vụ ${taskType}:`, innerError);
          }
        }
        if (importedCount === 0) {
          toastr.warning("Không nhập thành công preset nào", "ST-BME");
          return;
        }
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: mergedProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + mergedLegacyRuleCount;
        if (skippedLegacyConfigCount > 0) {
          console.warn(
            `[ST-BME] Khi nhập toàn bộ preset bản cũ đã phát hiện ${skippedLegacyConfigCount} cấu hình regex cấp tác vụ bổ sung bị xung đột. Hệ thống đã giữ lại mục đầu tiên và chuyển nó vào cấu hình regex dùng chung, các mục còn lại chỉ hợp nhất quy tắc.`,
          );
        }
        toastr.success(
          mergedRuleCount > 0
            ? `Đã nhập ${importedCount} preset tác vụ và hợp nhất ${mergedRuleCount} quy tắc regex dùng chung`
            : `Đã nhập ${importedCount} preset tác vụ`,
          "ST-BME",
        );
      } catch (error) {
        console.error("[ST-BME] NhậpTất cảpresetThất bại:", error);
        toastr.error(`NhậpTất cảpresetThất bại: ${error?.message || error}`, "ST-BME");
      } finally {
        importAllInput.value = "";
      }
    });
    importAllInput.dataset.bmeBound = "true";
  }
}

function _handleTaskProfileWorkspaceInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, false);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    // Đồng bộ thanh trượt ↔ ô nhập số
    const group = target.closest(".bme-range-group");
    if (group) {
      const key = target.dataset.generationKey;
      const sibling = group.querySelector(
        target.type === "range" ? `.bme-range-number` : `.bme-range-input`,
      );
      if (sibling) sibling.value = target.value;
      // Cập nhật giá trị hiển thị trên nhãn
      const row = target.closest(".bme-config-row");
      const badge = row?.querySelector(".bme-range-value");
      if (badge) badge.textContent = target.value || "Mặc định";
    }
    _persistGenerationField(target, false);
    return;
  }

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, false);
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, false);
    } else {
      _persistSelectedRegexRuleField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, false);
  }
}

function _handleTaskProfileWorkspaceChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

  if (target.id === "bme-task-profile-select") {
    const settings = _getSettings?.() || {};
    const nextTaskProfiles = setActiveTaskProfileId(
      settings.taskProfiles || {},
      currentTaskProfileTaskType,
      target.value,
    );
    currentTaskProfileBlockId = "";
    currentTaskProfileRuleId = "";
    _patchTaskProfiles(nextTaskProfiles);
    return;
  }

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, true);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    _persistGenerationField(target, true);
    return;
  }

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, true);
    return;
  }

  if (target.matches("[data-regex-field]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexField(target, false);
    } else {
      _persistRegexConfigField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-source]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexSourceField(target, false);
    } else {
      _persistRegexSourceField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-stage]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexStageField(target, false);
    } else {
      _persistRegexStageField(target, false);
    }
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, true);
    } else {
      _persistSelectedRegexRuleField(target, true);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, true);
  }
}

function _getTaskProfileWorkspaceState(settings = _getSettings?.() || {}) {
  const taskProfiles = ensureTaskProfiles(settings);
  const globalTaskRegex = _normalizeGlobalRegexDraft(settings.globalTaskRegex || {});
  const globalRegexRules = Array.isArray(globalTaskRegex.localRules)
    ? globalTaskRegex.localRules
    : [];
  const taskTypeOptions = getTaskTypeOptions();
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };

  if (!taskTypeOptions.some((item) => item.id === currentTaskProfileTaskType)) {
    currentTaskProfileTaskType = taskTypeOptions[0]?.id || "extract";
  }

  if (!TASK_PROFILE_TABS.some((item) => item.id === currentTaskProfileTabId)) {
    currentTaskProfileTabId = TASK_PROFILE_TABS[0]?.id || "generation";
  }

  const bucket = taskProfiles[currentTaskProfileTaskType] || {
    activeProfileId: "default",
    profiles: [],
  };
  const profile =
    bucket.profiles.find((item) => item.id === bucket.activeProfileId) ||
    bucket.profiles[0] ||
    null;
  const blocks = _sortTaskBlocks(profile?.blocks || []);
  const regexRules = Array.isArray(profile?.regex?.localRules)
    ? profile.regex.localRules
    : [];

  if (currentTaskProfileBlockId && !blocks.some((block) => block.id === currentTaskProfileBlockId)) {
    currentTaskProfileBlockId = blocks[0]?.id || "";
  }
  if (currentTaskProfileRuleId && !regexRules.some((rule) => rule.id === currentTaskProfileRuleId)) {
    currentTaskProfileRuleId = regexRules[0]?.id || "";
  }
  if (currentGlobalRegexRuleId && !globalRegexRules.some((rule) => rule.id === currentGlobalRegexRuleId)) {
    currentGlobalRegexRuleId = globalRegexRules[0]?.id || "";
  }

  return {
    settings,
    taskProfiles,
    globalTaskRegex,
    globalRegexRules,
    showGlobalRegex: showGlobalRegexPanel,
    taskTypeOptions,
    taskType: currentTaskProfileTaskType,
    taskTabId: currentTaskProfileTabId,
    bucket,
    profile,
    blocks,
    selectedBlock:
      blocks.find((block) => block.id === currentTaskProfileBlockId) || null,
    regexRules,
    selectedRule:
      regexRules.find((rule) => rule.id === currentTaskProfileRuleId) || null,
    selectedGlobalRegexRule:
      globalRegexRules.find((rule) => rule.id === currentGlobalRegexRuleId) || null,
    builtinBlockDefinitions: getBuiltinBlockDefinitions(),
    runtimeDebug,
  };
}

function _refreshTaskProfileWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-task-profile-workspace");
  if (!workspace) return;

  const state = _getTaskProfileWorkspaceState(settings);
  workspace.innerHTML = _renderTaskProfileWorkspace(state);
}

function _getMessageTraceWorkspaceState(settings = _getSettings?.() || {}) {
  const panelDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };
  const runtimeDebug = panelDebug.runtimeDebug || {};

  return {
    settings,
    panelDebug,
    runtimeDebug,
    recallInjection: runtimeDebug?.injections?.recall || null,
    graphLayout: runtimeDebug?.graphLayout || null,
    persistDelta: runtimeDebug?.graphPersistence?.persistDelta || null,
    messageTrace: runtimeDebug?.messageTrace || null,
    recallLlmRequest: runtimeDebug?.taskLlmRequests?.recall || null,
    recallPromptBuild: runtimeDebug?.taskPromptBuilds?.recall || null,
    extractLlmRequest: runtimeDebug?.taskLlmRequests?.extract || null,
    extractPromptBuild: runtimeDebug?.taskPromptBuilds?.extract || null,
    taskTimeline: Array.isArray(runtimeDebug?.taskTimeline)
      ? runtimeDebug.taskTimeline
      : [],
    graph: _getGraph?.() || null,
  };
}

function _refreshMessageTraceWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-message-trace-workspace");
  if (!workspace) return;

  const state = _getMessageTraceWorkspaceState(settings);
  workspace.innerHTML = _renderMessageTraceWorkspace(state);
}

function _renderMessageTraceWorkspace(state) {
  const updatedCandidates = [
    state.recallInjection?.updatedAt,
    state.graphLayout?.updatedAt,
    state.persistDelta?.updatedAt,
    state.recallLlmRequest?.updatedAt,
    state.extractLlmRequest?.updatedAt,
    state.extractPromptBuild?.updatedAt,
    ...(Array.isArray(state.taskTimeline)
      ? state.taskTimeline.map((entry) => entry?.updatedAt)
      : []),
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  const updatedAt = updatedCandidates.length
    ? new Date(Math.max(...updatedCandidates)).toISOString()
    : "";

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(updatedAt))}</span>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderMessageTraceRecallCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderMessageTraceExtractCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderAiMonitorTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderAiMonitorCognitionCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderGraphLayoutTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderPersistDeltaTraceCard(state)}
        </div>
      </div>
    </div>
  `;
}

function _renderMessageTraceRecallCard(state) {
  const injectionSnapshot = state.recallInjection || null;
  const recentMessages = Array.isArray(injectionSnapshot?.recentMessages)
    ? injectionSnapshot.recentMessages.map((item) => String(item || ""))
    : [];
  const lastSentUserMessage = String(
    state.messageTrace?.lastSentUserMessage?.text || "",
  ).trim();
  const triggeredUserMessage =
    lastSentUserMessage ||
    _extractTriggeredUserMessageFromRecentMessages(recentMessages);
  const hostPayloadText = _buildMainAiTraceText(
    triggeredUserMessage,
    injectionSnapshot?.injectionText || "",
  );
  const missingUserMessageNotice =
    injectionSnapshot && !triggeredUserMessage
      ? `
        <div class="bme-config-help">
          Lần này không bắt được đáng tin cậy tin nhắn người dùng từ phía AI chính, vì vậy ở đây chỉ hiển thị văn bản tiêm ký ức đã được ghi nhận thực tế, không còn dùng yêu cầu recall model để suy ngược lại nữa nhằm tránh gây hiểu lầm khi kiểm tra.
        </div>
      `
      : "";

  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">Nội dung cuối cùng được tiêm cho AI chính</div>
      <div class="bme-config-help">
        Vẫn chưa có snapshot tiêm truy hồi dùng được. Hãy gửi một tin nhắn bình thường để plugin chạy xong một vòng truy hồi.
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Nội dung cuối cùng được tiêm cho AI chính</div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    ${missingUserMessageNotice}
    ${_renderMessageTraceTextBlock(
      "Nội dung gửi cho AI chính",
      hostPayloadText,
      "Lần này không bắt được nội dung tiêm ở phía AI chính.",
    )}
  `;
}

function _renderMessageTraceExtractCard(state) {
  const extractLlmRequest = state.extractLlmRequest || null;
  const extractPromptBuild = state.extractPromptBuild || null;
  const extractPayloadText = _buildTraceMessagePayloadText(
    extractLlmRequest?.messages,
    extractPromptBuild,
  );

  if (!extractLlmRequest && !extractPromptBuild) {
    return `
      <div class="bme-config-card-title">Nội dung cuối cùng gửi cho model trích xuất</div>
      <div class="bme-config-help">
        Vẫn chưa có snapshot yêu cầu trích xuất dùng được. Chờ assistant trả lời xong một vòng bình thường và trích xuất tự động chạy qua thì nội dung sẽ hiện ở đây.
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Nội dung cuối cùng gửi cho model trích xuất</div>
      </div>
      <span class="bme-task-pill">${_escHtml(
        _formatTaskProfileTime(extractLlmRequest?.updatedAt || extractPromptBuild?.updatedAt),
      )}</span>
    </div>
    ${_renderMessageTraceTextBlock(
      "Nội dung gửi tới model trích xuất",
      extractPayloadText,
      "Lần này không bắt được nội dung yêu cầu trích xuất.",
    )}
  `;
}

function _formatDurationMs(durationMs) {
  const normalized = Number(durationMs);
  if (!Number.isFinite(normalized) || normalized <= 0) return "—";
  if (normalized < 1000) return `${Math.round(normalized)}ms`;
  return `${(normalized / 1000).toFixed(normalized >= 10000 ? 0 : 1)}s`;
}

function _getMonitorTaskTypeLabel(taskType = "") {
  const normalized = String(taskType || "").trim().toLowerCase();
  const labels = {
    extract: "Trích xuất",
    recall: "Truy hồi",
    consolidation: "Hợp nhất",
    compress: "Nén",
    synopsis: "Tóm tắt ngắn",
    summary_rollup: "Gộp tóm tắt",
    reflection: "Phản tư",
    sleep: "Lãng quên",
    evolve: "tiến hóa",
    embed: "Vector",
    rebuild: "xây lại",
  };
  return labels[normalized] || String(taskType || "Không rõTác vụ");
}

function _getMonitorStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "Không rõTrạng thái";
  if (normalized.includes("error") || normalized.includes("fail")) return "Thất bại";
  if (normalized.includes("run")) return "Đang chạy";
  if (normalized.includes("queue")) return "Đang xếp hàng";
  if (normalized.includes("pending")) return "Đang chờTrung bình";
  if (normalized.includes("skip")) return "Đã bỏ qua";
  if (normalized.includes("fallback")) return "Đã lùi về";
  if (normalized.includes("disable")) return "Đã tắt";
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized === "ok"
  ) {
    return "thành công";
  }
  return String(status || "Không rõTrạng thái");
}

function _getMonitorRoleLabel(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  const labels = {
    system: "hệ thống",
    user: "Người dùng",
    assistant: "trợ lý",
    tool: "Công cụ",
  };
  return labels[normalized] || String(role || "Không rõ");
}

function _getMonitorRouteLabel(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const labels = {
    "dedicated-openai-compatible": "dành riêng OpenAI tương thíchGiao diện",
    "dedicated-anthropic-claude": "Anthropic Claude Giao diện",
    "dedicated-google-ai-studio": "Google AI Studio / Gemini Giao diện",
    "sillytavern-current-model": "SillyTavernhiện tạiModel",
    "dedicated-memory-llm": "dành riêngKý ứcModel",
    global: "Đi theo API hiện tại",
    "task-preset": "Tác vụdành riêngmẫu",
    "global-fallback-missing-task-preset": "Thiếu preset tác vụ, đã lùi về API hiện tại",
    "global-fallback-invalid-task-preset": "Preset tác vụ không đầy đủ, đã lùi về API hiện tại",
  };
  return labels[normalized] || normalized;
}

function _getMonitorStageLabel(stage = "") {
  const normalized = String(stage || "").trim();
  if (!normalized) return "—";
  const labels = {
    "input.userMessage": "đầu vàogiai đoạn: hiện tạiTin nhắn người dùng",
    "input.recentMessages": "đầu vàogiai đoạn: Tin nhắn gần nhất",
    "input.candidateText": "đầu vàogiai đoạn: Văn bản ứng viên",
    "input.finalPrompt": "đầu vàogiai đoạn: cuối cùngprompt",
    "output.rawResponse": "đầu ragiai đoạn: nguyên gốcphản hồi",
    "output.beforeParse": "Đầu ra: trước khi phân tích",
    "world-info-rendered": "Sau khi World Info kết xuất",
    "final-injection-safe": "TiêmNội dungcuối cùnglàm sạch",
    "host:user_input": "HostTiêm: Người dùngđầu vào",
    "host:ai_output": "HostTiêm: AI đầu ra",
    "host:world_info": "HostTiêm: World Info",
    "host:reasoning": "Tiêm từ host: chuỗi suy nghĩ/suy luận",
  };
  return labels[normalized] || normalized;
}

function _formatMonitorStageList(stages = []) {
  if (!Array.isArray(stages) || !stages.length) return "—";
  return stages
    .map((entry) => _getMonitorStageLabel(entry?.stage || entry))
    .filter(Boolean)
    .join("、") || "—";
}

function _getMonitorEjsStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "";
  const labels = {
    primary: "Runtime chính",
    fallback: "Lùi vềruntime",
    failed: "Không khả dụng",
  };
  return labels[normalized] || String(status || "");
}

function _formatMonitorRouteInfo(entry = {}) {
  const parts = [
    _getMonitorRouteLabel(entry?.routeLabel || entry?.route),
    String(entry?.llmProviderLabel || "").trim(),
    _getMonitorRouteLabel(entry?.llmConfigSourceLabel),
    String(entry?.model || "").trim() ? `Model：${String(entry.model).trim()}` : "",
  ].filter(Boolean);
  const uniqueParts = [];
  for (const part of parts) {
    if (!uniqueParts.includes(part)) uniqueParts.push(part);
  }
  return uniqueParts.join(" · ") || "Chưa ghi nhận thông tin định tuyến";
}

function _summarizeMonitorGovernance(entry = {}) {
  const promptExecution = entry?.promptExecution || {};
  const worldInfo = promptExecution?.worldInfo || null;
  const regexInput = Array.isArray(promptExecution?.regexInput)
    ? promptExecution.regexInput
    : [];
  const requestCleaning = entry?.requestCleaning || null;
  const responseCleaning = entry?.responseCleaning || null;
  const persistence = entry?.batchStatus?.persistence || entry?.persistence || null;
  const lines = [];

  if (worldInfo) {
    lines.push(
      `World Info: ${worldInfo.hit ? "trúng" : "không trúng"} · Đặt trước ${Number(worldInfo.beforeCount || 0)} · đặt sau ${Number(worldInfo.afterCount || 0)} · độ sâu ${Number(worldInfo.atDepthCount || 0)}`,
    );
  }
  if (promptExecution?.ejsRuntimeStatus) {
    lines.push(`EJS: ${_getMonitorEjsStatusLabel(promptExecution.ejsRuntimeStatus)}`);
  }
  if (regexInput.length > 0) {
    const appliedRuleCount = regexInput.reduce(
      (sum, item) => sum + Number(item?.appliedRules?.length || 0),
      0,
    );
    lines.push(`Điều phối đầu vào: ${regexInput.length} đoạn · khớp ${appliedRuleCount} quy tắc`);
  }
  if (requestCleaning) {
    lines.push(
      `trước khi gửilàm sạch: ${requestCleaning.changed ? "Có thay đổi" : "Không thay đổi"} · giai đoạn ${_formatMonitorStageList(requestCleaning.stages)}`,
    );
  }
  if (responseCleaning) {
    lines.push(
      `phản hồilàm sạch: ${responseCleaning.changed ? "Có thay đổi" : "Không thay đổi"} · giai đoạn ${_formatMonitorStageList(responseCleaning.stages)}`,
    );
  }
  if (entry?.jsonFailure?.failureReason) {
    lines.push(`Thất bạiNguyên nhân: ${String(entry.jsonFailure.failureReason || "")}`);
  }
  if (persistence) {
    lines.push(
      `Lưu bền: ${_formatPersistenceOutcomeLabel(persistence.outcome)} · ${String(persistence.storageTier || "none")}${persistence.reason ? ` · ${String(persistence.reason)}` : ""}`,
    );
  }
  return lines;
}

function _buildMonitorMessagesPreview(messages = []) {
  const text = _stringifyTraceMessages(messages);
  if (!text) return "";
  if (text.length <= 1800) return text;
  return `${text.slice(0, 1800)}\n\n...(đã cắt ngắn)`;
}

function _renderAiMonitorTraceCard(state) {
  const timeline = Array.isArray(state.taskTimeline) ? state.taskTimeline : [];
  if (state.settings?.enableAiMonitor !== true) {
    return `
      <div class="bme-config-card-title">Giám sát tác vụDòng thời gian</div>
      <div class="bme-config-help">
        Giám sát tác vụ hiện đã tắt. Sau khi bật, nơi này sẽ giữ lại các snapshot gần nhất của tác vụ trích xuất / truy hồi / bảo trì để tiện điều tra đã gửi gì, dùng model nào và đã làm sạch những gì.
      </div>
    `;
  }

  if (!timeline.length) {
    return `
      <div class="bme-config-card-title">Giám sát tác vụDòng thời gian</div>
      <div class="bme-config-help">
        Vẫn chưa có dòng thời gian tác vụ. Sau khi trích xuất, truy hồi hoặc tác vụ bảo trì chạy xong một vòng, bản ghi gần nhất sẽ xuất hiện ở đây.
      </div>
    `;
  }

  const cards = timeline
    .slice(-8)
    .reverse()
    .map((entry, idx) => {
      const summaryLines = _summarizeMonitorGovernance(entry);
      const previewText = _buildMonitorMessagesPreview(entry?.messages || []);
      const modelLabel =
        String(entry?.llmPresetName || "").trim() ||
        String(entry?.llmConfigSourceLabel || "").trim() ||
        String(entry?.model || "").trim() ||
        "Không rõModel";
      const taskType = String(entry?.taskType || "unknown");
      const taskLabel = _getMonitorTaskTypeLabel(taskType);
      const status = String(entry?.status || "").toLowerCase();
      const dotClass = status.includes("error") || status.includes("fail")
        ? "dot-error"
        : status.includes("run")
          ? "dot-running"
          : "dot-success";
      const routeInfo = _formatMonitorRouteInfo(entry);

      // Governance tags
      const govTags = [];
      const pe = entry?.promptExecution || {};
      if (pe.worldInfo?.hit) govTags.push({ cls: "tag-worldinfo", label: `World Info ${Number(pe.worldInfo.beforeCount || 0) + Number(pe.worldInfo.afterCount || 0) + Number(pe.worldInfo.atDepthCount || 0)} mục` });
      if (pe.ejsRuntimeStatus) govTags.push({ cls: "tag-ejs", label: "EJS" });
      if (Array.isArray(pe.regexInput) && pe.regexInput.length) {
        const ruleCount = pe.regexInput.reduce((s, i) => s + Number(i?.appliedRules?.length || 0), 0);
        govTags.push({ cls: "tag-regex", label: `Regex ${ruleCount} mục` });
      }
      if (entry?.requestCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "gửilàm sạch" });
      if (entry?.responseCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "phản hồilàm sạch" });
      if (entry?.jsonFailure?.failureReason) govTags.push({ cls: "tag-error", label: "JSONThất bại" });

      const govTagsHtml = govTags.length
        ? `<div class="bme-ai-monitor-governance-tags">${govTags.map(t => `<span class="bme-ai-monitor-gov-tag ${t.cls}">${_escHtml(t.label)}</span>`).join("")}</div>`
        : "";

      const connector = idx < 7 ? `<div class="bme-ai-monitor-timeline-connector"></div>` : "";

      return `
        <div class="bme-ai-monitor-entry is-collapsed" data-bme-trace-idx="${idx}">
          <div class="bme-ai-monitor-entry__head">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              <div class="bme-ai-monitor-status-dot ${dotClass}"></div>
              <div style="min-width:0;flex:1">
                <div class="bme-ai-monitor-entry__title">${_escHtml(taskLabel)}
                  <span style="font-weight:400;opacity:0.5;font-size:11px;margin-left:4px">${_escHtml(_formatDurationMs(entry?.durationMs))}</span>
                </div>
                <div class="bme-ai-monitor-entry__meta">
                  ${_escHtml(
                    [
                      _getMonitorStatusLabel(entry?.status),
                      _formatTaskProfileTime(entry?.updatedAt),
                    ].filter(Boolean).join(" · "),
                  )}
                </div>
              </div>
            </div>
            <span class="bme-task-pill">${_escHtml(modelLabel)}</span>
            <button class="bme-ai-monitor-entry__toggle" type="button" title="Mở rộng/gập lại">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          ${govTagsHtml}
          <div class="bme-ai-monitor-entry__detail">
            <div class="bme-config-help">${_escHtml(routeInfo)}</div>
            ${
              summaryLines.length
                ? `<div class="bme-ai-monitor-entry__summary">${summaryLines
                    .map((line) => `<div>${_escHtml(line)}</div>`)
                    .join("")}</div>`
                : ""
            }
            ${_renderMessageTraceTextBlock(
              "Xem trước tin nhắn cuối cùng đã gửi",
              previewText,
              "Tác vụ này không bắt được bản xem trước tin nhắn đầy đủ.",
            )}
          </div>
        </div>
        ${connector}
      `;
    })
    .join("");

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Giám sát tác vụDòng thời gian</div>
        <div class="bme-config-card-subtitle">
          Gần nhất ${Math.min(timeline.length, 8)} snapshot tác vụ · nhấn để mở chi tiết
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(String(timeline.length))} mục</span>
    </div>
    <div class="bme-ai-monitor-stack">
      ${cards}
    </div>
  `;
}


function _renderAiMonitorCognitionCard(state) {
  const graph = state.graph || null;
  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const owners = _getCognitionOwnerCollection(graph);
  const latestRecallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Snapshot chạy của nhận thức / không gian</div>
        <div class="bme-config-card-subtitle">
          Nơi này hiển thị mốc neo nhận thức và ngữ cảnh không gian mới nhất đã thực sự được lưu xuống của chat hiện tại, không còn dựa vào phỏng đoán tạm thời từ frontend.
        </div>
      </div>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>Neo cảnh hiện tại</span>
        <strong>${_escHtml(
          latestRecallOwnerInfo.ownerLabels.length > 0
            ? latestRecallOwnerInfo.ownerLabels.join(" / ")
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Mốc neo cũ tương thích</span>
        <strong>${_escHtml(
          Array.isArray(historyState.recentRecallOwnerKeys) &&
            historyState.recentRecallOwnerKeys.length
            ? historyState.recentRecallOwnerKeys.join(" / ")
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Khu vực hiện tại</span>
        <strong>${_escHtml(
          activeRegion
            ? `${activeRegion}${
                historyState.activeRegionSource
                  ? ` · ${historyState.activeRegionSource}`
                  : ""
              }`
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Khu vực kề</span>
        <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "—")}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Số nhân vật nhận thức</span>
        <strong>${_escHtml(String(owners.length || 0))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Khu vực trích xuất gần nhất</span>
        <strong>${_escHtml(String(historyState.lastExtractedRegion || "—"))}</strong>
      </div>
    </div>
  `;
}

function _renderGraphLayoutTraceCard(state) {
  const layout = state.graphLayout || null;
  if (!layout) {
    return `
      <div class="bme-config-card-title">bố cục đồ thị / Native chẩn đoán</div>
      <div class="bme-config-help">
        Vẫn chưa có snapshot chẩn đoán bố cục đồ thị. Sau khi mở trang đồ thị và kích hoạt một lần bố cục, nơi này sẽ hiển thị đường đi thực thi, thời gian tiêu tốn và nguồn của mô-đun native.
      </div>
    `;
  }

  const mode = String(layout.mode || layout.solver || 'unknown').trim() || 'unknown';
  const moduleSource = String(layout.moduleSource || '').trim() || '—';
  const reason = String(layout.reason || '').trim() || '—';
  const nativeLoadError = String(layout.nativeLoadError || '').trim();

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">bố cục đồ thị / Native chẩn đoán</div>
        <div class="bme-config-card-subtitle">
          Bản ghi này cho biết lần bố cục đồ thị gần nhất đã đi theo đường nào, và mô-đun native là bản wasm-pack hay bộ nạp fallback.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(layout.updatedAt || layout.at))}</span>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>Đường đi bố cục</span>
        <strong>${_escHtml(mode)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>nút / cạnh</span>
        <strong>${_escHtml(`${Number(layout.nodeCount || 0)} / ${Number(layout.edgeCount || 0)}`)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Tổng thời gian</span>
        <strong>${_escHtml(_formatDurationMs(layout.totalMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Thời gian giải</span>
        <strong>${_escHtml(_formatDurationMs(layout.solveMs || layout.workerSolveMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Số vòng lặp</span>
        <strong>${_escHtml(String(layout.iterations || '—'))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native Nguồn</span>
        <strong>${_escHtml(moduleSource)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Trạng tháiNguyên nhân</span>
        <strong>${_escHtml(reason)}</strong>
      </div>
    </div>
    ${_renderMessageTraceTextBlock(
      'Native load error',
      nativeLoadError,
      'Hiện không có native load error。',
    )}
  `;
}

function _formatPersistDeltaGateReasonText(reasons = []) {
  const labels = {
    "below-record-threshold": "Số bản ghi không đủ",
    "below-structural-delta-threshold": "Mức thay đổi cấu trúc không đủ",
    "below-serialized-chars-threshold": "Dung lượng tuần tự hóa không đủ",
  };
  const normalized = Array.isArray(reasons)
    ? reasons
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  if (!normalized.length) return "—";
  return normalized.map((item) => labels[item] || item).join(" · ");
}

function _formatPersistDeltaGateText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") return "—";
  if (diagnostics.requestedNative !== true) return "Chưa yêu cầu native";
  if (diagnostics.nativeForceDisabled === true) return "Đã cưỡng chế tắt";
  if (diagnostics.gateAllowed === true) return "thông qua";
  return `Đã chặn · ${_formatPersistDeltaGateReasonText(diagnostics.gateReasons)}`;
}

function _renderPersistDeltaTraceCard(state) {
  const diagnostics = state.persistDelta || null;
  if (!diagnostics) {
    return `
      <div class="bme-config-card-title">Persist Delta / Native chẩn đoán</div>
      <div class="bme-config-help">
        Vẫn chưa có snapshot chẩn đoán persist delta. Sau khi đồ thị hoàn tất một lần ghi IndexedDB, nơi này sẽ hiển thị gate, đường đi thực thi, thời gian tiêu tốn và nguyên nhân fallback.
      </div>
    `;
  }

  const moduleSource = String(diagnostics.moduleSource || "").trim() || "—";
  const fallbackReason = String(diagnostics.fallbackReason || "").trim();
  const errorText = String(
    diagnostics.moduleError || diagnostics.preloadError || diagnostics.nativeError || "",
  ).trim();
  const payloadCharsText = diagnostics.combinedSerializedChars
    ? `${Number(diagnostics.combinedSerializedChars || 0)} / ${Number(diagnostics.minCombinedSerializedChars || 0)}`
    : "—";
  const cacheText = `${Number(diagnostics.serializationCacheHits || 0)}H / ${Number(
    diagnostics.serializationCacheMisses || 0,
  )}M`;
  const preparedSetCacheText = `${Number(
    diagnostics.preparedRecordSetCacheHits || 0,
  )}H / ${Number(diagnostics.preparedRecordSetCacheMisses || 0)}M`;

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Persist Delta / Native chẩn đoán</div>
        <div class="bme-config-card-subtitle">
          Bản ghi này cho biết gate của lần ghi tăng lượng gần nhất vào đồ thị, đường đi thực thi thật sự và cả tình trạng native preload / fallback.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(diagnostics.updatedAt))}</span>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>thực thiđường đi</span>
        <strong>${_escHtml(String(diagnostics.path || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Bridge chế độ</span>
        <strong>${_escHtml(
          `${String(diagnostics.requestedBridgeMode || "none")} → ${String(diagnostics.preparedBridgeMode || "none")}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native Gate</span>
        <strong>${_escHtml(_formatPersistDeltaGateText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Số bản ghi snapshot</span>
        <strong>${_escHtml(`${Number(diagnostics.beforeRecordCount || 0)} → ${Number(diagnostics.afterRecordCount || 0)}`)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Lượng thay đổi cấu trúc</span>
        <strong>${_escHtml(String(diagnostics.structuralDelta ?? "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Payload chars</span>
        <strong>${_escHtml(payloadCharsText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Tổng thời gian</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.totalMs || diagnostics.buildMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Thời gian xây dựng</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.buildMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Prepare / Native</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.prepareMs)} / ${_formatDurationMs(diagnostics.nativeAttemptMs)}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Lookup / JS Diff</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.lookupMs)} / ${_formatDurationMs(diagnostics.jsDiffMs)}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Hydrate / Cache</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.hydrateMs)} / ${cacheText}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>PreparedSet Cache</span>
        <strong>${_escHtml(preparedSetCacheText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Preload</span>
        <strong>${_escHtml(String(diagnostics.preloadStatus || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native Nguồn</span>
        <strong>${_escHtml(moduleSource)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Quy mô tăng lượng</span>
        <strong>${_escHtml(
          `${Number(diagnostics.upsertNodeCount || 0)}N / ${Number(diagnostics.upsertEdgeCount || 0)}E / ${Number(diagnostics.deleteNodeCount || 0)}DN / ${Number(diagnostics.deleteEdgeCount || 0)}DE`,
        )}</strong>
      </div>
    </div>
    ${_renderMessageTraceTextBlock(
      "Fallback reason",
      fallbackReason,
      "Lần này không xảy ra native fallback.",
    )}
    ${_renderMessageTraceTextBlock(
      "Preload / native error",
      errorText,
      "Hiện không có preload / native error。",
    )}
  `;
}

function _renderMessageTraceTextBlock(title, text, emptyText = "Chưa có nội dung") {
  const normalized = String(text || "").trim();
  return `
    <div class="bme-task-section-label">${_escHtml(title)}</div>
    ${
      normalized
        ? `<pre class="bme-debug-pre">${_escHtml(normalized)}</pre>`
        : `<div class="bme-debug-empty">${_escHtml(emptyText)}</div>`
    }
  `;
}

function _normalizeDebugMessages(messages = []) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const role = String(message.role || "").trim().toLowerCase();
      const content = String(message.content || "").trim();
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function _stringifyTraceMessages(messages = []) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (!normalizedMessages.length) return "";

  return normalizedMessages
    .map(
      (message) => `【${_getMonitorRoleLabel(message.role)}】\n${message.content}`,
    )
    .join("\n\n---\n\n");
}

function _buildMainAiTraceText(triggeredUserMessage = "", injectionText = "") {
  const sections = [];
  const normalizedUserMessage = String(triggeredUserMessage || "").trim();
  const normalizedInjectionText = String(injectionText || "").trim();

  if (normalizedUserMessage) {
    sections.push(`【Người dùng】\n${normalizedUserMessage}`);
  }
  if (normalizedInjectionText) {
    sections.push(`【Ký ứcTiêm】\n${normalizedInjectionText}`);
  }

  return sections.join("\n\n---\n\n").trim();
}

function _buildTraceMessagePayloadText(messages = [], promptBuild = null) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (normalizedMessages.length) {
    return _stringifyTraceMessages(normalizedMessages);
  }

  const fallbackMessages = [];
  const fallbackSystemPrompt = String(promptBuild?.systemPrompt || "").trim();
  if (fallbackSystemPrompt) {
    fallbackMessages.push({ role: "system", content: fallbackSystemPrompt });
  }

  for (const message of promptBuild?.privateTaskMessages || []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").trim().toLowerCase();
    const content = String(message.content || "").trim();
    if (!role || !content) continue;
    fallbackMessages.push({ role, content });
  }

  return _stringifyTraceMessages(fallbackMessages);
}

function _extractTriggeredUserMessageFromRecentMessages(recentMessages = []) {
  if (!Array.isArray(recentMessages)) return "";

  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const line = String(recentMessages[index] || "").trim();
    if (!line) continue;
    if (line.startsWith("[user]:")) {
      return line.replace(/^\[user\]:\s*/i, "").trim();
    }
  }
  return "";
}

function _patchTaskProfiles(taskProfiles, extraPatch = {}, options = {}) {
  return _patchSettings(
    {
      taskProfilesVersion: 3,
      taskProfiles,
      ...extraPatch,
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

async function _handleTaskProfileWorkspaceClick(event) {
  const actionEl = event.target.closest("[data-task-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.taskAction || "";
  const state = _getTaskProfileWorkspaceState();
  const selectedProfile = state.profile;
  if (
    !selectedProfile &&
    action !== "switch-task-type" &&
    action !== "switch-global-regex"
  ) return;

  switch (action) {
    case "switch-task-type":
      currentTaskProfileTaskType =
        actionEl.dataset.taskType || currentTaskProfileTaskType;
      showGlobalRegexPanel = false;
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _refreshTaskProfileWorkspace();
      return;
    case "switch-global-regex":
      showGlobalRegexPanel = true;
      _refreshTaskProfileWorkspace();
      return;
    case "switch-task-tab":
      currentTaskProfileTabId =
        actionEl.dataset.taskTab || currentTaskProfileTabId;
      _refreshTaskProfileWorkspace();
      return;
    case "refresh-task-debug":
      if (typeof _getRuntimeDebugSnapshot === "function") {
        _getRuntimeDebugSnapshot({ refreshHost: true });
      }
      _refreshTaskProfileWorkspace();
      return;
    case "inspect-tavern-regex":
      await _openRegexReuseInspector(state.taskType);
      return;
    case "select-block":
      currentTaskProfileBlockId = actionEl.dataset.blockId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "toggle-block-expand": {
      // Ignore if the click originated from a toggle switch, delete button, or drag handle
      const originEl = event.target;
      if (originEl.closest(".bme-task-row-toggle") || originEl.closest(".bme-task-row-btn-danger") || originEl.closest(".bme-task-drag-handle")) {
        return;
      }
      const blockId = actionEl.dataset.blockId || "";
      if (currentTaskProfileBlockId === blockId) {
        currentTaskProfileBlockId = "";
      } else {
        currentTaskProfileBlockId = blockId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "toggle-regex-rule-expand": {
      const originEl = event.target;
      if (
        originEl.closest(".bme-task-row-toggle") ||
        originEl.closest(".bme-task-row-btn-danger") ||
        originEl.closest(".bme-regex-drag-handle")
      ) {
        return;
      }
      const ruleId = actionEl.dataset.ruleId || "";
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId =
          currentGlobalRegexRuleId === ruleId ? "" : ruleId;
      } else {
        currentTaskProfileRuleId =
          currentTaskProfileRuleId === ruleId ? "" : ruleId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "select-regex-rule":
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      } else {
        currentTaskProfileRuleId = actionEl.dataset.ruleId || "";
      }
      _refreshTaskProfileWorkspace();
      return;
    case "add-custom-block":
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createCustomPromptBlock(context.taskType, {
          name: `Khối tùy chỉnh ${draft.blocks.length + 1}`,
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    case "add-builtin-block": {
      const select = document.getElementById("bme-task-builtin-select");
      const sourceKey = String(select?.value || "").trim();
      if (!sourceKey) {
        toastr.info("Hãy chọn một khối nguồn tích hợp trước", "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createBuiltinPromptBlock(context.taskType, sourceKey, {
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    }
    case "move-block-up":
      _moveTaskBlock(actionEl.dataset.blockId, -1);
      return;
    case "move-block-down":
      _moveTaskBlock(actionEl.dataset.blockId, 1);
      return;
    case "toggle-block-enabled":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = block.enabled === false;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: block.id };
      });
      return;
    case "toggle-block-enabled-cb":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = actionEl.checked;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: currentTaskProfileBlockId };
      });
      return;
    case "delete-block":
      _deleteTaskBlock(actionEl.dataset.blockId);
      return;
    case "save-profile":
      _patchTaskProfiles(state.taskProfiles, {}, { refresh: true });
      toastr.success("Preset hiện tại đã được lưu", "ST-BME");
      return;
    case "rename-profile": {
      const current = String(selectedProfile?.name || "").trim();
      const nextName = window.prompt("Hãy nhập tên preset", current);
      if (nextName == null) return;
      const trimmed = String(nextName).trim();
      if (!trimmed) {
        toastr.info("presetTênkhông thểtrống", "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft) => {
        draft.name = trimmed;
      });
      toastr.success("presetTênĐã cập nhật", "ST-BME");
      return;
    }
    case "save-as-profile": {
      const suggestedName = `${selectedProfile.name || "preset"} bản sao`;
      const nextName = window.prompt("Hãy nhập tên preset mới", suggestedName);
      if (nextName == null) return;
      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("presetTênkhông thểtrống", "ST-BME");
        return;
      }
      const nextProfile = cloneTaskProfile(selectedProfile, {
        taskType: currentTaskProfileTaskType,
        name: trimmedName,
      });
      currentTaskProfileBlockId = nextProfile.blocks?.[0]?.id || "";
      currentTaskProfileRuleId = nextProfile.regex?.localRules?.[0]?.id || "";
      const nextTaskProfiles = upsertTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        nextProfile,
        { setActive: true },
      );
      _patchTaskProfiles(nextTaskProfiles);
      toastr.success("Đã lưu thành preset mới", "ST-BME");
      return;
    }
    case "export-profile":
      _downloadTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        selectedProfile,
        state.globalTaskRegex,
      );
      return;
    case "import-profile":
      document.getElementById("bme-task-profile-import")?.click();
      return;
    case "export-all-profiles":
      _downloadAllTaskProfiles(state.taskProfiles, state.globalTaskRegex);
      return;
    case "import-all-profiles":
      document.getElementById("bme-task-profile-import-all")?.click();
      return;
    case "restore-all-profiles": {
      const confirmed = window.confirm(
        "Thao tác này sẽ khôi phục preset mặc định của cả 6 tác vụ về trạng thái xuất xưởng. Các preset tự định nghĩa đã lưu và quy tắc regex dùng chung sẽ không bị ảnh hưởng. Có tiếp tục không?",
      );
      if (!confirmed) return;
      const taskTypes = getTaskTypeOptions().map((t) => t.id);
      let restored = state.taskProfiles;
      const extraPatch = {};
      for (const tt of taskTypes) {
        restored = restoreDefaultTaskProfile(restored, tt);
        const lf = getLegacyPromptFieldForTask(tt);
        if (lf) extraPatch[lf] = "";
      }
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(restored, extraPatch);
      toastr.success(`Đã khôi phục preset mặc định của toàn bộ ${taskTypes.length} tác vụ`, "ST-BME");
      return;
    }
    case "restore-default-profile": {
      const confirmed = window.confirm(
        "Thao tác này sẽ xây lại preset mặc định của tác vụ hiện tại và chuyển sang preset mặc định. Có tiếp tục không?",
      );
      if (!confirmed) return;
      const nextTaskProfiles = restoreDefaultTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
      );
      const legacyField = getLegacyPromptFieldForTask(currentTaskProfileTaskType);
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(
        nextTaskProfiles,
        legacyField ? { [legacyField]: "" } : {},
      );
      toastr.success("Preset mặc định đã được khôi phục", "ST-BME");
      return;
    }
    case "add-regex-rule":
      _updateCurrentTaskProfile((draft, context) => {
        const localRules = Array.isArray(draft.regex?.localRules)
          ? draft.regex.localRules
          : [];
        const nextRule = createLocalRegexRule(context.taskType, {
          script_name: `Cục bộQuy tắc ${localRules.length + 1}`,
        });
        draft.regex = {
          ...(draft.regex || {}),
          localRules: [...localRules, nextRule],
        };
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-regex-rule":
      _deleteRegexRule(actionEl.dataset.ruleId);
      return;
    case "add-global-regex-rule":
      _updateGlobalTaskRegex((draft) => {
        const localRules = Array.isArray(draft.localRules) ? draft.localRules : [];
        const nextRule = createLocalRegexRule("global", {
          script_name: `dùng chungQuy tắc ${localRules.length + 1}`,
        });
        draft.localRules = [...localRules, nextRule];
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-global-regex-rule":
      _deleteGlobalRegexRule(actionEl.dataset.ruleId);
      return;
    case "select-global-regex-rule":
      currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "restore-global-regex-defaults": {
      const confirmed = window.confirm(
        "Thao tác này sẽ khôi phục quy tắc regex dùng chung về cấu hình mặc định. Có tiếp tục không?",
      );
      if (!confirmed) return;
      currentGlobalRegexRuleId = "";
      _patchGlobalTaskRegex(createDefaultGlobalTaskRegex(), { refresh: true });
      toastr.success("Quy tắc regex dùng chung đã được khôi phục về mặc định", "ST-BME");
      return;
    }
    default:
      return;
  }
}

function _renderTaskProfileWorkspace(state) {
  if (!state.profile) {
    return `
      <div class="bme-config-card">
        <div class="bme-config-card-title">Preset tác vụKhông khả dụng</div>
        <div class="bme-config-help">Hiện không có dữ liệu preset tác vụ nào có thể chỉnh sửa.</div>
      </div>
    `;
  }

  const taskMeta =
    state.taskTypeOptions.find((item) => item.id === state.taskType) ||
    state.taskTypeOptions[0];
  const profileUpdatedAt = _formatTaskProfileTime(state.profile.updatedAt);

  return `
    <div class="bme-task-shell">
      <div class="bme-task-action-bar">
        <div class="bme-task-nav-groups">
          <div class="bme-task-segmented-control">
            ${state.taskTypeOptions
              .map(
                (item) => `
                  <button
                    class="bme-task-type-btn ${item.id === state.taskType && !state.showGlobalRegex ? "active" : ""}"
                    data-task-action="switch-task-type"
                    data-task-type="${_escAttr(item.id)}"
                    type="button"
                  >${_escHtml(item.label)}</button>
                `,
              )
              .join("")}
          </div>
          <div class="bme-task-segmented-control bme-task-segmented-control--solo">
            <button
              class="bme-task-type-btn ${state.showGlobalRegex ? "active" : ""}"
              data-task-action="switch-global-regex"
              type="button"
            >
              dùng chungRegex
            </button>
          </div>
        </div>
        <div class="bme-task-action-bar-right">
          <button class="bme-config-secondary-btn bme-bulk-profile-btn bme-task-btn-danger" data-task-action="restore-all-profiles" type="button" title="Khôi phục preset mặc định của cả 6 tác vụ">
            <i class="fa-solid fa-arrows-rotate"></i><span>Khôi phụcTất cả</span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="export-all-profiles" type="button" title="XuấtTất cả 6 preset tác vụ">
            <i class="fa-solid fa-file-export"></i><span>XuấtTất cả</span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="import-all-profiles" type="button" title="NhậpTất cảpreset（bao phủhiện tại）">
            <i class="fa-solid fa-file-import"></i><span>NhậpTất cả</span>
          </button>
        </div>
      </div>

      ${state.showGlobalRegex
        ? _renderGlobalRegexPanel(state)
        : `
      <div class="bme-task-master-detail">
        <div class="bme-task-profile-editor">
          <div class="bme-task-editor-header">
            <div class="bme-task-editor-kicker">${_escHtml(taskMeta?.label || state.taskType)}</div>
            <div class="bme-task-editor-title-row">
              <label class="bme-visually-hidden" for="bme-task-profile-select">hiện tạipreset</label>
              <select id="bme-task-profile-select" class="bme-config-input bme-task-editor-preset-select" title="chuyển đổipreset">
                ${state.bucket.profiles
                  .map(
                    (profile) => `
                  <option
                    value="${_escAttr(profile.id)}"
                    ${profile.id === state.profile.id ? "selected" : ""}
                  >
                    ${_escHtml(profile.name)}${profile.builtin ? "（tích hợp sẵn）" : ""}
                  </option>
                `,
                  )
                  .join("")}
              </select>
              <div class="bme-task-profile-badges">
                <span class="bme-task-pill ${state.profile.builtin ? "is-builtin" : ""}">
                  ${state.profile.builtin ? "tích hợp sẵn" : "tự định nghĩa"}
                </span>
                <span class="bme-task-pill">Cập nhật lúc ${_escHtml(profileUpdatedAt)}</span>
              </div>
            </div>
            <div class="bme-task-editor-actions">
              <button class="bme-config-secondary-btn" data-task-action="save-profile" type="button"><i class="fa-solid fa-floppy-disk"></i><span>Lưu</span></button>
              <button class="bme-config-secondary-btn" data-task-action="rename-profile" type="button"><i class="fa-solid fa-pen"></i><span>Đổi tên</span></button>
              <button class="bme-config-secondary-btn" data-task-action="save-as-profile" type="button"><i class="fa-solid fa-copy"></i><span>Lưu thành</span></button>
              <button class="bme-config-secondary-btn" data-task-action="import-profile" type="button"><i class="fa-solid fa-file-import"></i><span>Nhập</span></button>
              <button class="bme-config-secondary-btn" data-task-action="export-profile" type="button"><i class="fa-solid fa-file-export"></i><span>Xuất</span></button>
              <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-default-profile" type="button"><i class="fa-solid fa-arrows-rotate"></i><span>Khôi phụcMặc định</span></button>
            </div>
          </div>

          <div class="bme-task-subtabs">
            ${TASK_PROFILE_TABS.map(
              (tab) => `
                <button
                  class="bme-task-subtab-btn ${tab.id === state.taskTabId ? "active" : ""}"
                  data-task-action="switch-task-tab"
                  data-task-tab="${_escAttr(tab.id)}"
                  type="button"
                >
                  ${_escHtml(tab.label)}
                </button>
              `,
            ).join("")}
          </div>

          <div class="bme-task-tab-body">
            ${
              state.taskTabId === "generation"
                ? _renderTaskGenerationTab(state)
                : state.taskTabId === "debug"
                  ? _renderTaskDebugTab(state)
                  : _renderTaskPromptTab(state)
            }
          </div>
        </div>
      </div>
      `}
    </div>
  `;
}
function _renderTaskPromptTab(state) {
  return `
    <div class="bme-task-toolbar-row">
      <div class="bme-task-toolbar-inline">
        <button class="bme-config-secondary-btn" data-task-action="add-custom-block" type="button">
          + Khối tùy chỉnh
        </button>
        <span class="bme-task-action-sep"></span>
        <select id="bme-task-builtin-select" class="bme-config-input bme-task-builtin-select">
          ${state.builtinBlockDefinitions
            .map(
              (item) => `
                <option value="${_escAttr(item.sourceKey)}">
                  ${_escHtml(item.name)}
                </option>
              `,
            )
            .join("")}
        </select>
        <button class="bme-config-secondary-btn" data-task-action="add-builtin-block" type="button">
          + Khối tích hợp
        </button>
      </div>
      <span class="bme-task-block-count">${state.blocks.length} khối</span>
    </div>

    <div class="bme-task-block-rows">
      ${state.blocks.length
        ? state.blocks
            .map((block, index) => _renderTaskBlockRow(block, index, state))
            .join("")
        : `
            <div class="bme-task-empty">
              Preset hiện tại vẫn chưa có khối nào. Bạn có thể thêm một khối tùy chỉnh hoặc khối tích hợp trước.
            </div>
          `}
    </div>
  `;
}

function _renderTaskGenerationTab(state) {
  const inputGroups = TASK_PROFILE_INPUT_GROUPS[state.taskType] || [];
  return `
    <div class="bme-task-tab-body">
      ${TASK_PROFILE_GENERATION_GROUPS.map(
        (group) => `
          <div class="bme-config-card">
            <div class="bme-config-card-head">
              <div>
                <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                <div class="bme-config-card-subtitle">
                  Để trống nghĩa là không cưỡng chế gửi xuống, sẽ do model hoặc giá trị mặc định của provider quyết định.
                </div>
              </div>
            </div>
            <div class="bme-task-field-grid">
              ${group.fields
                .map((field) =>
                  _renderGenerationField(
                    field,
                    state.profile.generation?.[field.key],
                    state,
                  ),
                )
                .join("")}
            </div>
          </div>
        `,
      ).join("")}
      ${inputGroups
        .map(
          (group) => `
            <div class="bme-config-card">
              <div class="bme-config-card-head">
                <div>
                  <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                  <div class="bme-config-card-subtitle">
                    Cấu hình tại đây là quy tắc thu thập đầu vào đi kèm theo tác vụ, không đi theo phần trích xuất ngữ cảnh toàn cục.
                  </div>
                </div>
              </div>
              <div class="bme-task-field-grid">
                ${group.fields
                  .map((field) =>
                    _renderTaskInputField(
                      field,
                      state.profile.input?.[field.key],
                    ),
                  )
                  .join("")}
              </div>
            </div>
          `,
        )
        .join("")}
      <div class="bme-task-note">
        <strong>Mô tả runtime</strong> — cấu hình ở đây có bộ generation options đầy đủ. Trước khi gửi yêu cầu thật, hệ thống vẫn sẽ lọc theo năng lực của model để tránh gửi thẳng các trường không được hỗ trợ cho provider.
      </div>
    </div>
  `;
}

function _renderTaskRegexTab(state, options = {}) {
  const regex = options.regex || state.profile?.regex || {};
  const regexRules = Array.isArray(options.regexRules)
    ? options.regexRules
    : state.regexRules;
  const selectedRule =
    options.selectedRule === undefined ? state.selectedRule : options.selectedRule;
  const normalizedStages = normalizeTaskRegexStages(regex.stages || {});
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const addAction = options.addAction || "add-regex-rule";
  const addButtonLabel = options.addButtonLabel || "+ Thêm quy tắc";
  const wrapperClassName = options.wrapperClassName
    ? ` ${options.wrapperClassName}`
    : "";
  const sectionTitle = options.sectionTitle || "Tái sử dụng và giai đoạn";
  const sectionSubtitle =
    options.sectionSubtitle ||
    "Preset tác vụ có thể tái sử dụng regex của SillyTavern và chồng thêm các quy tắc bổ sung của chính tác vụ hiện tại.";
  const rulesTitle = options.rulesTitle || "Quy tắc bổ sung cục bộ";
  const rulesSubtitle =
    options.rulesSubtitle ||
    "Quy tắc cục bộ chỉ dùng cho preset tác vụ hiện tại, sẽ không làm bẩn cấu hình host SillyTavern.";
  const emptyText = options.emptyText || "Preset hiện tại vẫn chưa có quy tắc regex cục bộ nào.";
  const defaultNamePrefix = options.defaultNamePrefix || "Cục bộQuy tắc";
  const headerExtraActions = options.extraHeaderActions || "";
  const enableToggleTitle = options.enableToggleTitle || "BậtTác vụRegex";
  const enableToggleDesc =
    options.enableToggleDesc || "Sau khi tắt, cấu hình hiện tại sẽ không thực thi bất kỳ regex cấp tác vụ nào.";
  const editorState = {
    ...state,
    selectedRule,
  };

  return `
    <div class="bme-task-tab-body${wrapperClassName}">
      <div class="bme-regex-settings-stack">
        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-config-card-head">
            <div>
              <div class="bme-config-card-title">${_escHtml(sectionTitle)}</div>
              <div class="bme-config-card-subtitle">
                ${_escHtml(sectionSubtitle)}
              </div>
            </div>
            <div class="bme-task-inline-actions">
              <button class="bme-config-secondary-btn" data-task-action="inspect-tavern-regex" type="button">
                xemhiện tạidùng lạiQuy tắc
              </button>
              ${headerExtraActions}
            </div>
          </div>

          <div class="bme-task-toggle-list">
            <label class="bme-toggle-item">
              <span class="bme-toggle-copy">
                <span class="bme-toggle-title">${_escHtml(enableToggleTitle)}</span>
                <span class="bme-toggle-desc">${_escHtml(enableToggleDesc)}</span>
              </span>
              <input
                type="checkbox"
                data-regex-field="enabled"
                ${regex.enabled ? "checked" : ""}
              />
            </label>

            <label class="bme-toggle-item">
              <span class="bme-toggle-copy">
                <span class="bme-toggle-title">dùng lạiSillyTavernRegex</span>
                <span class="bme-toggle-desc">Đọc global / preset / character RegexNguồn。</span>
              </span>
              <input
                type="checkbox"
                data-regex-field="inheritStRegex"
                ${regex.inheritStRegex !== false ? "checked" : ""}
              />
            </label>
          </div>
        </div>

        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-task-section-label">dùng lạiNguồn</div>
          <div class="bme-task-toggle-list">
            ${[
              ["global", "Toàn cục"],
              ["preset", "hiện tạipreset"],
              ["character", "Thẻ nhân vật"],
            ]
              .map(
                ([key, label]) => `
                  <label class="bme-toggle-item">
                    <span class="bme-toggle-copy">
                      <span class="bme-toggle-title">${label}</span>
                      <span class="bme-toggle-desc">Bật nguồn Tavern Regex cho ${label}.</span>
                    </span>
                    <input
                      type="checkbox"
                      data-regex-source="${key}"
                      ${(regex.sources?.[key] ?? true) ? "checked" : ""}
                    />
                  </label>
                `,
              )
              .join("")}
          </div>
        </div>

        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-task-section-label">thực thigiai đoạn</div>
          <div class="bme-task-toggle-list">
            ${TASK_PROFILE_REGEX_STAGES.map(
              (stage) => `
                <label class="bme-toggle-item">
                  <span class="bme-toggle-copy">
                    <span class="bme-toggle-title">${_escHtml(stage.label)}</span>
                    <span class="bme-toggle-desc">${_escHtml(stage.desc)}</span>
                  </span>
                  <input
                    type="checkbox"
                    data-regex-stage="${_escAttr(stage.key)}"
                    ${isTaskRegexStageEnabled(normalizedStages, stage.key) ? "checked" : ""}
                  />
                </label>
              `,
            ).join("")}
          </div>
        </div>
      </div>

      <div class="bme-config-card bme-regex-rule-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">${_escHtml(rulesTitle)}</div>
            <div class="bme-config-card-subtitle">
              ${_escHtml(rulesSubtitle)}
            </div>
          </div>
          <button class="bme-config-secondary-btn" data-task-action="${_escAttr(addAction)}" type="button">
            ${_escHtml(addButtonLabel)}
          </button>
        </div>

        <div class="bme-regex-rule-rows">
          ${regexRules.length
            ? regexRules
                .map((rule, index) =>
                  _renderRegexRuleRow(rule, index, editorState, {
                    deleteAction,
                    defaultNamePrefix,
                  })
                )
                .join("")
            : `
                <div class="bme-task-empty">
                  ${_escHtml(emptyText)}
                </div>
              `}
        </div>
      </div>
    </div>
  `;
}

function _renderGlobalRegexPanel(state) {
  return _renderTaskRegexTab(
    {
      ...state,
      selectedRule: state.selectedGlobalRegexRule,
    },
    {
      regex: state.globalTaskRegex,
      regexRules: state.globalRegexRules,
      selectedRule: state.selectedGlobalRegexRule,
      addAction: "add-global-regex-rule",
      selectAction: "select-global-regex-rule",
      deleteAction: "delete-global-regex-rule",
      addButtonLabel: "+ Thêm quy tắc dùng chung",
      wrapperClassName: "bme-global-regex-panel",
      sectionTitle: "dùng chungRegexcài đặt",
      sectionSubtitle: "Tất cả tác vụ cùng dùng chung một bộ công tắc regex tác vụ, nguồn tái sử dụng, giai đoạn thực thi và quy tắc bổ sung.",
      enableToggleTitle: "Bậtdùng chungRegex",
      enableToggleDesc: "Sau khi tắt, mọi tác vụ sẽ không thực thi bất kỳ cấu hình regex dùng chung nào.",
      rulesTitle: "Quy tắc bổ sung dùng chung",
      rulesSubtitle: "Tại đây quản lý các quy tắc bổ sung dùng chung cho toàn bộ tác vụ.",
      emptyText: "Hiện vẫn chưa códùng chungRegexQuy tắc。",
      defaultNamePrefix: "dùng chungQuy tắc",
      extraHeaderActions: `
        <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-global-regex-defaults" type="button">
          Khôi phụcMặc định
        </button>
      `,
    },
  );
}
function _formatRegexReuseSourceState(source = {}) {
  const states = [];
  states.push(source.enabled ? "Đã bật" : "Đã tắt");
  states.push(source.allowed === false ? "Chưa được SillyTavern cho phép" : "Được phép tham gia");
  states.push(
    source.resolvedVia === "bridge"
      ? "thông quacầu nốiĐọc"
      : source.resolvedVia === "fallback"
        ? "thông qua fallback Đọc"
        : "NguồnKhông rõ",
  );
  return states.join(" · ");
}

function _formatRegexReuseSourceLabel(sourceType = "") {
  if (sourceType === "global") return "Toàn cục";
  if (sourceType === "preset") return "preset";
  if (sourceType === "character") return "Thẻ nhân vật";
  if (sourceType === "local") return "Tác vụCục bộ";
  return sourceType ? String(sourceType) : "Không rõ";
}

function _formatRegexReuseReplaceText(rule = {}) {
  if (rule.promptStageMode === "display-only") {
    return "（Quy tắc chỉ hiển thị, không đi vào yêu cầu Memory LLM）";
  }
  if (rule.promptStageMode === "fallback-skip-beautify") {
    return "（Thay thế làm đẹp, ở chế độ fallback sẽ không đi vào prompt）";
  }
  if (typeof rule.effectivePromptReplaceString === "string" && rule.effectivePromptReplaceString.length > 0) {
    return rule.effectivePromptReplaceString;
  }
  if (typeof rule.replaceString === "string" && rule.replaceString.length > 0) {
    return rule.replaceString;
  }
  return "（Rỗng - Xóa nội dung khớp）";
}

function _renderRegexReuseBadges(rule = {}) {
  const badges = [];
  if (rule.promptStageMode === "display-only") {
    badges.push({
      className: "is-clear",
      text: "Chỉ hiển thị",
    });
  } else if (rule.promptStageMode === "host-real") {
    badges.push({
      className: "is-transform",
      text: "Host thực thi thật",
    });
  } else if (rule.promptStageMode === "host-helper") {
    badges.push({
      className: "is-prompt",
      text: "Helper tương thíchthực thi",
    });
  } else if (rule.promptStageMode === "host-fallback") {
    badges.push({
      className: "is-prompt",
      text: "plugintương thíchthực thi",
    });
  } else if (rule.promptStageMode === "fallback-skip-beautify") {
    badges.push({
      className: "is-skip",
      text: "Fallback bỏ qua làm đẹp",
    });
  } else if (rule.promptStageMode === "replace") {
    badges.push({
      className: "is-transform",
      text: "Cục bộcuối cùngRegex",
    });
  } else {
    badges.push({
      className: "is-skip",
      text: "Hiện tại không thực thi",
    });
  }
  if (rule.markdownOnly) {
    badges.push({
      className: "is-skip",
      text: "Bỏ qua(MD)",
    });
  }
  if (rule.promptOnly) {
    badges.push({
      className: "is-prompt",
      text: "Chỉ prompt",
    });
  }
  if (
    rule.sourceType === "local" &&
    rule.promptStageMode !== "skip" &&
    rule.promptStageApplies === false
  ) {
    badges.push({
      className: "is-skip",
      text: "Tác vụ hiện tại chưa bật",
    });
  }
  return badges
    .map(
      (badge) => `<span class="bme-regex-preview-item__badge ${badge.className}">${_escHtml(badge.text)}</span>`,
    )
    .join("");
}

function _renderRegexReuseRuleList(rules = [], emptyText = "Không", options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return `<div class="bme-task-empty">${_escHtml(emptyText)}</div>`;
  }

  const {
    showSource = false,
    showReason = false,
    startIndex = 0,
    muted = false,
  } = options || {};

  return rules
    .map((rule, index) => {
      const placementText = Array.isArray(rule.placementLabels) && rule.placementLabels.length
        ? rule.placementLabels.join("，")
        : "Chưa khai báo phạm vi tác dụng";
      const sourceLabel = _formatRegexReuseSourceLabel(rule.sourceType || "");
      const metaBits = [];
      if (showSource) {
        metaBits.push(`Nguồn：${sourceLabel}`);
      }
      if (showReason && rule.reason) {
        metaBits.push(rule.reason);
      }
      return `
        <div class="bme-regex-preview-item ${muted ? "is-muted" : ""}">
          <div class="bme-regex-preview-item__head">
            <div class="bme-regex-preview-item__title-group">
              <span class="bme-regex-preview-item__index">#${startIndex + index + 1}</span>
              <span class="bme-regex-preview-item__name">${_escHtml(rule.name || rule.id || "Quy tắc chưa đặt tên")}</span>
            </div>
            <div class="bme-regex-preview-item__badges">
              ${_renderRegexReuseBadges(rule)}
            </div>
          </div>
          <div class="bme-regex-preview-item__details">
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">tìm</span>
              <code>${_escHtml(rule.findRegex || "(findRegex rỗng)")}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">Thay thế</span>
              <code>${_escHtml(_formatRegexReuseReplaceText(rule))}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">Phạm vi tác dụng</span>
              <span>${_escHtml(placementText)}</span>
            </div>
            ${showSource ? `
              <div class="bme-regex-preview-item__row">
                <span class="bme-regex-preview-item__label">Nguồn</span>
                <span>${_escHtml(sourceLabel)}</span>
              </div>
            ` : ""}
          </div>
          ${metaBits.length ? `
            <div class="bme-regex-preview-item__meta">${_escHtml(metaBits.join(" · "))}</div>
          ` : ""}
        </div>
      `;
    })
    .join("");
}

function _buildRegexReusePopupContent(snapshot = {}) {
  const container = document.createElement("div");
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const activeRules = Array.isArray(snapshot.activeRules) ? snapshot.activeRules : [];
  const stageConfig = snapshot.stageConfig && typeof snapshot.stageConfig === "object"
    ? snapshot.stageConfig
    : {};
  const sourceConfig = snapshot.sourceConfig && typeof snapshot.sourceConfig === "object"
    ? snapshot.sourceConfig
    : {};
  const sourceSummaryText = [
    `global=${sourceConfig.global === false ? "tắt" : "bật"}`,
    `preset=${sourceConfig.preset === false ? "tắt" : "bật"}`,
    `character=${sourceConfig.character === false ? "tắt" : "bật"}`,
  ].join(" / ");
  const stageSummaryText =
    Object.entries(stageConfig)
      .map(([key, value]) => `${key}=${value ? "on" : "off"}`)
      .join(" | ") || "Không";

  container.innerHTML = `
    <div class="bme-task-tab-body bme-regex-preview-screen">
        <div class="bme-regex-preview-hero">
        <div class="bme-regex-preview-hero__title">Tổng quan script regex hiện tại</div>
        <div class="bme-regex-preview-hero__subtitle">
          Tại đây hiển thị những Tavern Regex nào sẽ được ST-BME tái sử dụng để xử lý nội dung tiêm cho host trong preset tác vụ hiện tại, cùng với những regex tác vụ cục bộ nào sẽ được thực thi ở bước cuối trước khi gửi.
        </div>
        <div class="bme-regex-preview-summary">
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">Tác vụ</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.taskType || "—")}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">preset</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.profileName || snapshot.profileId || "—")}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">Tác vụRegex</span>
            <span class="bme-regex-preview-summary__value">${snapshot.regexEnabled ? "Đã bật" : "Đã tắt"}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">dùng lại Tavern</span>
            <span class="bme-regex-preview-summary__value">${snapshot.inheritStRegex ? "Đã bật" : "Đã tắt"}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">Quy tắc đã thu thập</span>
            <span class="bme-regex-preview-summary__value">${Number(snapshot.activeRuleCount || activeRules.length || 0)}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">cầu nốichế độ</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.host?.sourceLabel || "unknown")} · ${_escHtml(snapshot.host?.executionMode || snapshot.host?.capabilityStatus?.mode || snapshot.host?.mode || "unknown")}${snapshot.host?.bridgeTier ? ` · ${_escHtml(snapshot.host.bridgeTier)}` : ""}${snapshot.host?.formatterAvailable ? " · formatter" : ""}${snapshot.host?.fallback ? " · fallback" : ""}</span>
          </div>
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">HostTiêmdùng lạiQuy tắc</div>
            <div class="bme-regex-preview-panel__subtitle">Tại đây chỉ hiển thị các quy tắc Tavern sẽ tham gia xử lý "Văn bản tiêm cho host"; các quy tắc chỉ hiển thị sẽ được đánh dấu rõ ràng.</div>
          </div>
        </div>
        <div class="bme-task-note">
          Nguồncông tắc：${_escHtml(sourceSummaryText)}<br>
          giai đoạncông tắc：${_escHtml(stageSummaryText)}
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(activeRules, "Hiện không tái sử dụng bất kỳ SillyTavern Regex nào", {
            showSource: true,
          })}
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">Tác vụCục bộcuối cùngRegex</div>
            <div class="bme-regex-preview-panel__subtitle">Nhóm này chỉ được thực thi ở giai đoạn <code>input.finalPrompt</code> cuối cùng trước khi gửi, không tham gia làm sạch phần tiêm cho host.</div>
          </div>
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(snapshot.localRules, "Hiện không cóTác vụCục bộcuối cùngRegex", {
            showSource: false,
          })}
        </div>
      </div>

      <details class="bme-debug-details bme-regex-preview-details">
        <summary>Chi tiết nguồn và loại trừ</summary>
        <div class="bme-regex-preview-details__body">
        ${
          sources.length
            ? sources.map((source) => `
                <div class="bme-regex-preview-source">
                  <div class="bme-regex-preview-source__head">
                    <div class="bme-regex-preview-source__title">${_escHtml(source.label || source.type || "Không rõNguồn")}</div>
                    <div class="bme-regex-preview-source__meta">${_escHtml(_formatRegexReuseSourceState(source))}</div>
                  </div>
                  <div class="bme-task-note">
                    raw=${Number(source.rawRuleCount || 0)} / active=${Number(source.activeRuleCount || 0)}
                    ${source.reason ? `<br>${_escHtml(source.reason)}` : ""}
                  </div>
                  <div class="bme-task-section-label">Tổng quan quy tắc của nguồn này</div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.previewRules || source.rules, "Nguồn này hiện không có quy tắc nào để hiển thị")}
                  </div>
                  <div class="bme-task-section-label">Chưa được đưa vào chuỗi tác vụ cuối cùng</div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.ignoredRules, "Không có quy tắc bổ sung nào bị loại trừ", {
                      showReason: true,
                      muted: true,
                    })}
                  </div>
                </div>
              `).join("")
            : `<div class="bme-task-empty">Hiện không có nguồn SillyTavern Regex nào để hiển thị.</div>`
        }
        </div>
      </details>
    </div>
  `;

  return container;
}

async function _openRegexReuseInspector(taskType) {
  if (typeof _actionHandlers.inspectTaskRegexReuse !== "function") {
    toastr.info("Runtime hiện tại chưa nối vào lối chẩn đoán tái sử dụng regex", "ST-BME");
    return;
  }

  try {
    const snapshot = await _actionHandlers.inspectTaskRegexReuse(taskType);
    const content = _buildRegexReusePopupContent(snapshot || {});
    const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
    await callGenericPopup(content, POPUP_TYPE.TEXT, "", {
      okButton: "Tắt",
      wide: true,
      large: true,
      allowVerticalScrolling: true,
    });
  } catch (error) {
    console.error("[ST-BME] Mở hộp kiểm tra tái sử dụng regex thất bại:", error);
    toastr.error("Mở hộp kiểm tra tái sử dụng regex thất bại", "ST-BME");
  }
}

function _renderTaskDebugTab(state) {
  const hostCapabilities = state.runtimeDebug?.hostCapabilities || null;
  const runtimeDebug = state.runtimeDebug?.runtimeDebug || {};
  const promptBuild = runtimeDebug?.taskPromptBuilds?.[state.taskType] || null;
  const llmRequest = runtimeDebug?.taskLlmRequests?.[state.taskType] || null;
  const recallInjection = runtimeDebug?.injections?.recall || null;
  const maintenanceDebug = runtimeDebug?.maintenance || null;
  const graphPersistence = runtimeDebug?.graphPersistence || null;

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <div class="bme-task-note">
          Tại đây hiển thị snapshot gỡ lỗi do lần chạy thực tế gần nhất để lại, không phải suy diễn cấu hình tĩnh. Nếu chưa có dữ liệu thì chỉ cần chạy tác vụ tương ứng một lần trước.
        </div>
        <button class="bme-config-secondary-btn" data-task-action="refresh-task-debug" type="button">
          làm mớiTrạng thái
        </button>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderTaskDebugHostCard(hostCapabilities)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugGraphPersistenceCard(graphPersistence)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugMaintenanceCard(maintenanceDebug)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugPromptCard(state.taskType, promptBuild)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugLlmCard(state.taskType, llmRequest)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugInjectionCard(recallInjection)}
        </div>
      </div>
    </div>
  `;
}

function _renderTaskDebugMaintenanceCard(maintenanceDebug) {
  const lastAction = maintenanceDebug?.lastAction || null;
  const lastUndoResult = maintenanceDebug?.lastUndoResult || null;

  if (!lastAction && !lastUndoResult) {
    return `
      <div class="bme-config-card-title">bảo trìsổ cáiTrạng thái</div>
      <div class="bme-config-help">Hiện vẫn chưa có snapshot bảo trì hoặc hoàn tác gần nhất.</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">bảo trìsổ cáiTrạng thái</div>
        <div class="bme-config-card-subtitle">
          Bản ghi bảo trì gần nhất và kết quả hoàn tác gần nhất.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(lastAction?.action || lastUndoResult?.action || "maintenance")}</span>
    </div>
    ${_renderDebugDetails("Gần nhấtbảo trì", lastAction)}
    ${_renderDebugDetails("Gần nhấthoàn tác", lastUndoResult)}
  `;
}

function _renderTaskDebugGraphPersistenceCard(graphPersistence) {
  if (!graphPersistence) {
    return `
      <div class="bme-config-card-title">đồ thịTrạng thái lưu bền</div>
      <div class="bme-config-help">Hiện vẫn chưa cóđồ thịtải/Lưu bềnsnapshot。</div>
    `;
  }

  const persistDelta = graphPersistence.persistDelta || null;

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">đồ thịTrạng thái lưu bền</div>
        <div class="bme-config-card-subtitle">
          Kết quả điều phối tải và ghi ngược đồ thị gần nhất.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(graphPersistence.loadState || "unknown")}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">chat</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.chatId || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Nguyên nhân</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.reason || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Số lần thử</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.attemptIndex ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">hiện tại revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.graphRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Revision lưu bền gần nhất</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastPersistedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Revision đã được chấp nhận gần nhất</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastAcceptedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hồ sơ host</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.hostProfile || "generic-st"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Durable chính</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.primaryStorageTier || "none"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Bộ đệm cục bộ</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.cacheStorageTier || "none"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Luker Sidecar</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `v${Number(graphPersistence.lukerSidecarFormatVersion || 0) || 1}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Manifest / Checkpoint</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `rev ${Number(graphPersistence.lukerManifestRevision || 0)} / cp ${Number(graphPersistence.lukerCheckpointRevision || 0)}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Journal / Cache Lag</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `${Number(graphPersistence.lukerJournalDepth || 0)} mục / lag ${Number(graphPersistence.cacheLag || 0)}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Revision đang xếp hàng</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.queuedPersistRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Chờ xác nhậnghi vào</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.pendingPersist ? "Có" : "Không")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Snapshot bóng</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.shadowSnapshotUsed ? "Đã tiếp quản" : "Chưa dùng")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Bảo vệ ghi</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.writesBlocked ? "Đã bật" : "Chưa bật")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Bất thường nhất quán</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatPersistMismatchReason(graphPersistence.persistMismatchReason))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Commit Marker</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.commitMarker
            ? [
                `rev ${Number(graphPersistence.commitMarker.revision || 0)}`,
                graphPersistence.commitMarker.accepted === true ? "accepted" : "pending",
                graphPersistence.commitMarker.storageTier || "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Delta đường đi</span>
        <span class="bme-debug-kv-value">${_escHtml(String(persistDelta?.path || "—"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Native Gate</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatPersistDeltaGateText(persistDelta))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Thời gian Persist Delta</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatDurationMs(persistDelta?.totalMs || persistDelta?.buildMs))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Native Nguồn</span>
        <span class="bme-debug-kv-value">${_escHtml(String(persistDelta?.moduleSource || "—"))}</span>
      </div>
    </div>
    ${_renderDebugDetails("đồ thịLưu bềnchi tiết", graphPersistence)}
  `;
}

function _renderTaskDebugHostCard(hostCapabilities) {
  if (!hostCapabilities) {
    return `
      <div class="bme-config-card-title">Hostcầu nốiTrạng thái</div>
      <div class="bme-config-help">Hiện vẫn chưa cóHostcầu nốisnapshot。</div>
    `;
  }

  const capabilityNames = ["context", "worldbook", "regex", "injection"];
  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Hostcầu nốiTrạng thái</div>
        <div class="bme-config-card-subtitle">
          Tình trạng kết nối hiện tại giữa plugin và SillyTavern.
        </div>
      </div>
      <span class="bme-task-pill ${hostCapabilities.available ? "is-builtin" : ""}">
        ${hostCapabilities.mode || (hostCapabilities.available ? "available" : "unavailable")}
      </span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Trạng thái tổng</span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.available ? "dùng được" : "Không khả dụng")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">mô tả</span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.fallbackReason || "Không")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">snapshotphiên bản</span>
        <span class="bme-debug-kv-value">${_escHtml(String(hostCapabilities.snapshotRevision ?? "—"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">snapshotthời gian</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatTaskProfileTime(hostCapabilities.snapshotCreatedAt))}</span>
      </div>
    </div>
    <div class="bme-task-section-label">Năng lực theo hạng mục</div>
    <div class="bme-debug-capability-list">
      ${capabilityNames
        .map((name) => {
          const capability = hostCapabilities[name] || {};
          return `
            <div class="bme-debug-capability-item">
              <div class="bme-debug-capability-head">
                <span class="bme-debug-capability-title">${_escHtml(name)}</span>
                <span class="bme-task-pill ${capability.available ? "is-builtin" : ""}">
                  ${_escHtml(capability.mode || (capability.available ? "available" : "unavailable"))}
                </span>
              </div>
              <div class="bme-debug-capability-desc">
                ${_escHtml(capability.fallbackReason || "Không")}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function _renderTaskDebugPromptCard(taskType, promptBuild) {
  if (!promptBuild) {
    return `
      <div class="bme-config-card-title">Lần lắp ráp prompt gần nhất</div>
      <div class="bme-config-help">Tác vụ hiện tại vẫn chưa có snapshot lắp ráp prompt gần nhất.</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Lần lắp ráp prompt gần nhất</div>
        <div class="bme-config-card-subtitle">
          Kết quả điều phối thực tế gần nhất của tác vụ ${_escHtml(taskType)}.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(promptBuild.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">preset</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.profileName || promptBuild.profileId || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Số lượng khối</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.renderedBlockCount ?? promptBuild.renderedBlocks?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Tiêmkế hoạch</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.hostInjectionPlanCount ?? promptBuild.debug?.hostInjectionCount ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Tin nhắn riêng tư</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.executionMessageCount ?? promptBuild.executionMessages?.length ?? promptBuild.privateTaskMessages?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">EJS Trạng thái</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.ejsRuntimeStatus || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">World Info</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.effectivePath?.worldInfo || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Bộ đệm World Info</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.worldInfoCacheHit ? "trúng" : "không trúng")}</span>
      </div>
    </div>
    ${_renderDebugDetails("Đường đi phát thực tế", promptBuild.debug?.effectivePath || null)}
    ${_renderDebugDetails("Các khối sau khi kết xuất (theo thứ tự cấu hình)", promptBuild.renderedBlocks)}
    ${_renderDebugDetails("Chuỗi tin nhắn thực thi thực tế", promptBuild.executionMessages || promptBuild.privateTaskMessages || null)}
    ${_renderDebugDetails("Prompt hệ thống (góc nhìn tương thích, không gồm tin nhắn atDepth)", promptBuild.systemPrompt || "")}
    ${_renderDebugDetails("Nội dung bucket World Info (chẩn đoán)", promptBuild.hostInjections)}
    ${_renderDebugDetails("Kế hoạch khối World Info trúng (chẩn đoán)", promptBuild.hostInjectionPlan || null)}
    ${_renderDebugDetails("Gỡ lỗi World Info", promptBuild.worldInfo?.debug || promptBuild.worldInfoResolution?.debug || null)}
  `;
}

function _renderTaskDebugLlmCard(taskType, llmRequest) {
  if (!llmRequest) {
    return `
      <div class="bme-config-card-title">Tham số phát thực tế gần nhất</div>
      <div class="bme-config-help">Tác vụ hiện tại vẫn chưa có snapshot yêu cầu LLM gần nhất.</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Tham số phát thực tế gần nhất</div>
        <div class="bme-config-card-subtitle">
          Thông tin gửi thực tế khi tác vụ ${_escHtml(taskType)} đi qua lớp yêu cầu riêng tư lần gần nhất.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(llmRequest.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">yêu cầuNguồn</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestSource || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">yêu cầuđường đi</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.routeLabel || _getMonitorRouteLabel(llmRequest.route || "") || llmRequest.route || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Kênh nhận diện</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmProviderLabel || llmRequest.llmProvider || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Model</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.model || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Cấu hình APINguồn</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmConfigSourceLabel || llmRequest.llmConfigSource || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Tác vụ API mẫu</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmPresetName || (llmRequest.requestedLlmPresetName ? `thiếu hụt: ${llmRequest.requestedLlmPresetName}` : "Đi theo API hiện tại"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">năng lựcChế độ lọc</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.capabilityMode || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Ẩn nhạy cảm khi gỡ lỗi</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.redacted ? "Đã ẩn nhạy cảm" : "Chưa đánh dấu")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">thực tếđường đi</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.effectiveRoute?.llm || llmRequest.route || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">đầu ralàm sạch</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.responseCleaning?.applied ? "Đã có hiệu lực" : "Chưa có hiệu lực")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">trước khi gửiđầu vàolàm sạch</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestCleaning?.applied ? "Đã có hiệu lực" : "Chưa có hiệu lực")}</span>
      </div>
    </div>
    ${_renderDebugDetails("promptthực thitóm tắt", llmRequest.promptExecution || null)}
    ${_renderDebugDetails("trước khi gửiđầu vàolàm sạch", llmRequest.requestCleaning || null)}
    ${_renderDebugDetails("thực tếyêu cầuđường đi", llmRequest.effectiveRoute || null)}
    ${_renderDebugDetails("đầu ralàm sạch", llmRequest.responseCleaning || null)}
    ${_renderDebugDetails("Cấu hình APIphân tích", {
      llmConfigSource: llmRequest.llmConfigSource || "",
      llmConfigSourceLabel: llmRequest.llmConfigSourceLabel || "",
      requestedLlmPresetName: llmRequest.requestedLlmPresetName || "",
      llmPresetName: llmRequest.llmPresetName || "",
      llmPresetFallbackReason: llmRequest.llmPresetFallbackReason || "",
    })}
    ${_renderDebugDetails("Tham số được giữ lại thực tế", llmRequest.filteredGeneration || {})}
    ${_renderDebugDetails("Tham số đã bị lọc bỏ", llmRequest.removedGeneration || [])}
    ${_renderDebugDetails("cuối cùngtin nhắndanh sách", llmRequest.messages || [])}
    ${_renderDebugDetails("Phần thân yêu cầu cuối cùng", llmRequest.requestBody || null)}
  `;
}

function _renderTaskDebugInjectionCard(injectionSnapshot) {
  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">Gần nhấtTiêmKết quả</div>
      <div class="bme-config-help">Vẫn chưa có snapshot tiêm truy hồi gần nhất.</div>
    `;
  }

  const llmMeta = injectionSnapshot.llmMeta || {};
  const rawSelectedKeys = Array.isArray(llmMeta.rawSelectedKeys)
    ? llmMeta.rawSelectedKeys.join(", ")
    : "";
  const resolvedSelectedNodeIds = Array.isArray(llmMeta.resolvedSelectedNodeIds)
    ? llmMeta.resolvedSelectedNodeIds.join(", ")
    : "";

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Gần nhấtTiêmKết quả</div>
        <div class="bme-config-card-subtitle">
          Hiển thị văn bản tiêm và cách phát tới host sau lần truy hồi gần nhất.
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Nguồn</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.sourceLabel || injectionSnapshot.source || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hook kích hoạt</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.hookName || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Số nút chọn trung bình</span>
        <span class="bme-debug-kv-value">${_escHtml(String(injectionSnapshot.selectedNodeIds?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Giao thức LLM chọn lọc</span>
        <span class="bme-debug-kv-value">${_escHtml(llmMeta.selectionProtocol || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Khóa ngắn gốc</span>
        <span class="bme-debug-kv-value">${_escHtml(rawSelectedKeys || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">phân tíchnút</span>
        <span class="bme-debug-kv-value">${_escHtml(resolvedSelectedNodeIds || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Lùi vềLoại</span>
        <span class="bme-debug-kv-value">${_escHtml(llmMeta.fallbackType || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Phát tới host</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.transport?.source || "—")} / ${_escHtml(injectionSnapshot.transport?.mode || "—")}</span>
      </div>
    </div>
    ${_renderDebugDetails("Truy hồithống kê", {
      retrievalMeta: injectionSnapshot.retrievalMeta || {},
      llmMeta: injectionSnapshot.llmMeta || {},
      stats: injectionSnapshot.stats || {},
      transport: injectionSnapshot.transport || {},
    })}
    ${_renderDebugDetails("cuối cùngVăn bản tiêm", injectionSnapshot.injectionText || "")}
  `;
}

function _renderDebugDetails(title, value) {
  const isEmptyArray = Array.isArray(value) && value.length === 0;
  const isEmptyObject =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
  const isEmpty = value == null || value === "" || isEmptyArray || isEmptyObject;

  return `
    <details class="bme-debug-details" ${isEmpty ? "" : "open"}>
      <summary>${_escHtml(title)}</summary>
      ${
        isEmpty
          ? '<div class="bme-debug-empty">Chưa có nội dung</div>'
          : `<pre class="bme-debug-pre">${_escHtml(_stringifyDebugValue(value))}</pre>`
      }
    </details>
  `;
}

function _stringifyDebugValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function _getBlockTypeIcon(type) {
  switch (type) {
    case "builtin": return `<i class="fa-solid fa-thumbtack"></i>`;
    case "legacyPrompt": return `<i class="fa-solid fa-scroll"></i>`;
    default: return `<i class="fa-regular fa-file-lines"></i>`;
  }
}

function _getInjectModeLabel(mode) {
  switch (mode) {
    case "append": return "Nối thêm";
    case "relative":
    default: return "Tương đối";
  }
}

function _renderTaskBlockRow(block, index, state) {
  const isExpanded = block.id === state.selectedBlock?.id;
  const roleClass = `bme-badge-role-${block.role || "system"}`;
  const disabledClass = block.enabled ? "" : "is-disabled";
  const expandedClass = isExpanded ? "is-expanded" : "";

  return `
    <div
      class="bme-task-block-row ${disabledClass} ${expandedClass}"
      data-block-id="${_escAttr(block.id)}"
    >
      <div class="bme-task-block-row-header" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}">
        <span
          class="bme-task-drag-handle"
          title="Kéo thả để sắp xếp"
          aria-label="Kéo thả để sắp xếp"
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-task-block-icon">
          ${_getBlockTypeIcon(block.type)}
        </span>
        <span class="bme-task-block-name">
          ${_escHtml(block.name || _getTaskBlockTypeLabel(block.type))}
        </span>
        <span class="bme-task-block-badge ${roleClass}">
          ${_escHtml(block.role || "system")}
        </span>
        <span class="bme-task-block-badge">
          ${_escHtml(_getInjectModeLabel(block.injectionMode))}
        </span>
        <span class="bme-task-block-row-spacer"></span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-block-expand"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="Chỉnh sửa"
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="delete-block"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="Xóa"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${block.enabled ? "Đã bật" : "Đã tắt"}">
          <input
            type="checkbox"
            data-task-action="toggle-block-enabled-cb"
            data-block-id="${_escAttr(block.id)}"
            ${block.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded ? `
        <div class="bme-task-block-expand">
          ${_renderTaskBlockInlineEditor(block, state)}
        </div>
      ` : ""}
    </div>
  `;
}

function _renderTaskBlockInlineEditor(block, state) {
  const builtinOptions = state.builtinBlockDefinitions
    .map(
      (item) => `
        <option
          value="${_escAttr(item.sourceKey)}"
          ${item.sourceKey === block.sourceKey ? "selected" : ""}
        >
          ${_escHtml(item.name)}
        </option>
      `,
    )
    .join("");
  const legacyField = getLegacyPromptFieldForTask(state.taskType);
  const legacyValue =
    legacyField && block.type === "legacyPrompt"
      ? state.settings?.[legacyField] || block.content || getDefaultPromptText(state.taskType) || ""
      : block.content || "";

  return `
    <div class="bme-config-row">
      <label>Tên khối</label>
      <input
        class="bme-config-input"
        type="text"
        data-block-field="name"
        value="${_escAttr(block.name || "")}"
        placeholder="Dùng để hiển thị trong khu vực làm việc"
      />
    </div>

    <div class="bme-task-expand-row2">
      <div class="bme-config-row">
        <label>Nhân vật</label>
        <select class="bme-config-input" data-block-field="role">
          ${TASK_PROFILE_ROLE_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === block.role ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
      <div class="bme-config-row">
        <label>Cách tiêm</label>
        <select class="bme-config-input" data-block-field="injectionMode">
          ${TASK_PROFILE_INJECTION_OPTIONS.map(
            (item) => `
              <option
                value="${item.value}"
                ${item.value === (block.injectionMode || "append") ? "selected" : ""}
              >
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    </div>

    ${
      block.type === "builtin"
        ? (() => {
            const externalSourceMap = {
              charDescription: "Mô tả thẻ nhân vật",
              userPersona: "Người dùng Persona thiết lập",
              worldInfoBefore: "World Info (↑ Char)",
              worldInfoAfter: "World Info (↓ Char)",
            };
            const externalLabel = externalSourceMap[block.sourceKey];
            return `
            <div class="bme-config-row">
              <label>Nguồn tích hợp sẵn${_helpTip("Runtime sẽ tự động đọc dữ liệu được tiêm từ ngữ cảnh tác vụ.")}</label>
              <select class="bme-config-input" data-block-field="sourceKey">
                ${builtinOptions}
              </select>
            </div>
            ${externalLabel
              ? `<div class="bme-task-note" style="text-align:center;padding:0.75rem;opacity:0.7;">
                   Nguồn nội dung: <strong>${externalLabel}</strong>, không thể chỉnh sửa tại đây.
                 </div>`
              : `<div class="bme-config-row">
                   <label>Nội dung ghi đè (tùy chọn)${_helpTip("Để trống thì sẽ tự động đọc dữ liệu ngữ cảnh tương ứng với sourceKey.")}</label>
                   <textarea
                     class="bme-config-textarea"
                     data-block-field="content"
                     placeholder="Để trống thì đọc từ ngữ cảnh tác vụ tương ứng với sourceKey."
                   >${_escHtml(block.content || "")}</textarea>
                 </div>`
            }`;
          })()
        : block.type === "legacyPrompt"
          ? `
              <div class="bme-task-note">
                Khối hiện tại vẫn giữ tương thích với trường prompt bản cũ. Nếu để trống, runtime sẽ lùi về prompt mặc định tích hợp sẵn.
              </div>
              <div class="bme-config-row">
                <label>Trường tương thích</label>
                <input class="bme-config-input" type="text" value="${_escAttr(legacyField || block.sourceField || "")}" readonly />
              </div>
              <div class="bme-config-row">
                <label>tương thích prompt Nội dung</label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="Để trống = tiếp tục dùng prompt mặc định tích hợp sẵn"
                >${_escHtml(legacyValue)}</textarea>
              </div>
            `
          : `
              <div class="bme-config-row">
                <label>Nội dung khối</label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="Hỗ trợ các biến nhẹ như {{userMessage}} / {{recentMessages}} / {{schema}}..."
                >${_escHtml(block.content || "")}</textarea>
              </div>
            `
    }

    <div class="bme-task-expand-footer">
      <button class="bme-config-secondary-btn" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}" type="button">
        <i class="fa-solid fa-chevron-up"></i> Thu gọn
      </button>
    </div>
  `;
}

function _renderGenerationField(field, value, state = {}) {
  const effectiveValue = (value != null && value !== "") ? value : field.defaultValue;

  if (field.type === "llm_preset") {
    const presetMap =
      state?.settings && typeof state.settings === "object"
        ? state.settings.llmPresets || {}
        : {};
    const presetNames = Object.keys(presetMap).sort((left, right) =>
      left.localeCompare(right, "zh-Hans-CN"),
    );
    const currentValue = String(effectiveValue || "");
    const hasCurrentPreset =
      !currentValue || presetNames.includes(currentValue);
    const currentLabel = !currentValue
      ? "Đi theo API hiện tại"
      : hasCurrentPreset
        ? currentValue
        : `${currentValue} (đã mất, sẽ lùi về API hiện tại)`;
    const options = [
      {
        value: "",
        label: "Đi theo API hiện tại",
      },
      ...(!currentValue || hasCurrentPreset
        ? []
        : [{ value: currentValue, label: currentLabel }]),
      ...presetNames.map((name) => ({
        value: name,
        label: name,
      })),
    ];

    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${options
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === currentValue ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  if (field.type === "tri_bool") {
    const currentValue =
      effectiveValue === true ? "true" : effectiveValue === false ? "false" : "";
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="tri_bool"
        >
          ${TASK_PROFILE_BOOLEAN_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === currentValue ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === String(effectiveValue ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "range") {
    const numValue = effectiveValue != null && effectiveValue !== "" ? Number(effectiveValue) : "";
    const displayValue = numValue !== "" ? numValue : field.min ?? 0;
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)} <span class="bme-range-value">${numValue !== "" ? numValue : "Mặc định"}</span></label>
        <div class="bme-range-group">
          <input
            class="bme-range-input"
            type="range"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${displayValue}"
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
          <input
            class="bme-config-input bme-range-number"
            type="number"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${_escAttr(numValue)}"
            placeholder="Mặc định"
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
        </div>
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="${field.type === "text" ? "text" : "number"}"
        ${field.step ? `step="${field.step}"` : ""}
        value="${_escAttr(effectiveValue ?? "")}"
        placeholder="Để trống = Theo mặc định"
        data-generation-key="${_escAttr(field.key)}"
        data-value-type="${field.type === "text" ? "text" : "number"}"
      />
    </div>
  `;
}

function _formatRegexRulePreview(findRegex = "") {
  const collapsed = String(findRegex || "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "(chưa điền find_regex)";
}

function _renderRegexRuleRow(rule, index, state, options = {}) {
  const isExpanded = rule.id === state.selectedRule?.id;
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const defaultNamePrefix = options.defaultNamePrefix || "Cục bộQuy tắc";
  const statusLabel = rule.enabled ? "Bật" : "Tắt";
  const previewText = _formatRegexRulePreview(rule.find_regex);

  return `
    <div
      class="bme-regex-rule-row ${isExpanded ? "is-expanded" : ""} ${rule.enabled ? "" : "is-disabled"}"
      data-rule-id="${_escAttr(rule.id)}"
    >
      <div
        class="bme-regex-rule-row-header"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
      >
        <span
          class="bme-task-drag-handle bme-regex-drag-handle"
          title="Kéo thả để sắp xếp"
          aria-label="Kéo thả để sắp xếp"
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-regex-rule-name">
          ${_escHtml(rule.script_name || `${defaultNamePrefix} ${index + 1}`)}
        </span>
        <span class="bme-regex-rule-status ${rule.enabled ? "is-enabled" : "is-disabled"}">
          ${_escHtml(statusLabel)}
        </span>
        <span class="bme-regex-rule-preview" title="${_escAttr(previewText)}">
          ${_escHtml(previewText)}
        </span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-regex-rule-expand"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="Chỉnh sửa"
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="${_escAttr(deleteAction)}"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="Xóa"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${rule.enabled ? "Đã bật" : "Đã tắt"}">
          <input
            type="checkbox"
            data-regex-rule-row-enabled="true"
            data-rule-id="${_escAttr(rule.id)}"
            ${rule.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded
        ? `
            <div class="bme-regex-rule-expand">
              ${_renderRegexRuleInlineEditor(rule)}
            </div>
          `
        : ""}
    </div>
  `;
}

function _renderRegexRuleInlineEditor(rule) {
  const trimStrings = Array.isArray(rule.trim_strings)
    ? rule.trim_strings.join("\n")
    : String(rule.trim_strings || "");

  return `
    <div class="bme-task-note">
      Các trường nên giữ thẳng hàng với cấu trúc Tavern Regex càng nhiều càng tốt để thuận tiện cho việc nhập xuất và đối chiếu về sau.
    </div>

    <div class="bme-config-row">
      <label>Quy tắcTên</label>
        <input
          class="bme-config-input"
          type="text"
          data-regex-rule-field="script_name"
          value="${_escAttr(rule.script_name || "")}"
        />
    </div>

    <label class="bme-toggle-item bme-task-editor-toggle">
      <span class="bme-toggle-copy">
        <span class="bme-toggle-title">Bật quy tắc này</span>
        <span class="bme-toggle-desc">Sau khi tắt, quy tắc này sẽ không còn tham gia xử lý của preset tác vụ hiện tại.</span>
      </span>
      <input
        type="checkbox"
        data-regex-rule-field="enabled"
        ${rule.enabled ? "checked" : ""}
      />
    </label>

    <div class="bme-config-row">
      <label>tìmRegex (find_regex)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="find_regex"
        placeholder="/pattern/g"
      >${_escHtml(rule.find_regex || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>Văn bản thay thế (replace_string)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="replace_string"
        placeholder="Văn bản sau khi thay thế"
      >${_escHtml(rule.replace_string || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>Chuỗi cần cắt bỏ (trim_strings)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="trim_strings"
        placeholder="Mỗi dòng là một chuỗi cần cắt bỏ"
      >${_escHtml(trimStrings)}</textarea>
    </div>

    <div class="bme-task-field-grid">
      <div class="bme-config-row">
        <label>Độ sâu nhỏ nhất</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="min_depth"
          value="${_escAttr(rule.min_depth ?? 0)}"
        />
      </div>
      <div class="bme-config-row">
        <label>Độ sâu lớn nhất</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="max_depth"
          value="${_escAttr(rule.max_depth ?? 9999)}"
        />
      </div>
    </div>

    <div class="bme-task-section-label">Dữ liệuNguồn</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">Người dùngđầu vào</span>
          <span class="bme-toggle-desc">Cho phép áp dụng cho văn bản phía user / đầu vào.</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="user_input"
          ${(rule.source?.user_input ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">AI đầu ra</span>
          <span class="bme-toggle-desc">Cho phép áp dụng cho văn bản phía assistant / đầu ra.</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="ai_output"
          ${(rule.source?.ai_output ?? true) ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-section-label">Mục tiêu tác dụng</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">Prompt xây dựng</span>
          <span class="bme-toggle-desc">Áp dụng vào chuỗi xử lý xây dựng prompt đầu vào.</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="prompt"
          ${(rule.destination?.prompt ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">Hiển thị giao diện</span>
          <span class="bme-toggle-desc">Áp dụng vào chuỗi xử lý thay thế ở tầng hiển thị.</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="display"
          ${rule.destination?.display ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-expand-footer">
      <button
        class="bme-config-secondary-btn"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
        type="button"
      >
        <i class="fa-solid fa-chevron-up"></i> Thu gọn
      </button>
    </div>
  `;
}

function _moveTaskBlock(blockId, direction) {
  if (!blockId || !Number.isFinite(direction) || direction === 0) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) {
      return null;
    }
    [blocks[index], blocks[targetIndex]] = [blocks[targetIndex], blocks[index]];
    // Đánh số lại trực tiếp, đừng sort nữa (nếu không sẽ bị xếp lại theo thứ tự cũ)
    draft.blocks = blocks.map((block, i) => ({ ...block, order: i }));
    return { selectBlockId: blockId };
  });
}

function _getTaskBlockDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearTaskBlockDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-task-block-row.dragging, .bme-task-block-row.drag-over-top, .bme-task-block-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setTaskBlockDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-task-block-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderTaskBlocks(sourceBlockId, targetBlockId, position = "before") {
  if (!sourceBlockId || !targetBlockId || sourceBlockId === targetBlockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const sourceIndex = blocks.findIndex((item) => item.id === sourceBlockId);
    const targetIndex = blocks.findIndex((item) => item.id === targetBlockId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceBlock] = blocks.splice(sourceIndex, 1);
    let insertIndex = targetIndex;

    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }

    insertIndex = Math.max(0, Math.min(blocks.length, insertIndex));
    blocks.splice(insertIndex, 0, sourceBlock);
    draft.blocks = blocks.map((block, index) => ({ ...block, order: index }));
    return { selectBlockId: sourceBlockId };
  });
}

function _deleteTaskBlock(blockId) {
  if (!blockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    if (index < 0) return null;
    const block = blocks[index];

    blocks.splice(index, 1);
    draft.blocks = _normalizeTaskBlocks(blocks);
    return {
      selectBlockId: blocks[Math.max(0, index - 1)]?.id || blocks[0]?.id || "",
    };
  });
}

function _deleteRegexRule(ruleId) {
  if (!ruleId) return;
  _updateCurrentTaskProfile((draft) => {
    const localRules = Array.isArray(draft.regex?.localRules)
      ? [...draft.regex.localRules]
      : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _getRegexRuleDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearRegexRuleDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-regex-rule-row.dragging, .bme-regex-rule-row.drag-over-top, .bme-regex-rule-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setRegexRuleDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-regex-rule-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderRegexRules(sourceRuleId, targetRuleId, position = "before", isGlobal = false) {
  if (!sourceRuleId || !targetRuleId || sourceRuleId === targetRuleId) return;
  const applyReorder = (rules = []) => {
    const nextRules = Array.isArray(rules) ? [...rules] : [];
    const sourceIndex = nextRules.findIndex((item) => item.id === sourceRuleId);
    const targetIndex = nextRules.findIndex((item) => item.id === targetRuleId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceRule] = nextRules.splice(sourceIndex, 1);
    let insertIndex = targetIndex;
    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }
    insertIndex = Math.max(0, Math.min(nextRules.length, insertIndex));
    nextRules.splice(insertIndex, 0, sourceRule);
    return nextRules;
  };

  if (isGlobal) {
    _updateGlobalTaskRegex((draft) => {
      const localRules = applyReorder(draft.localRules);
      if (!localRules) return null;
      draft.localRules = localRules;
      return { selectRuleId: sourceRuleId };
    });
    return;
  }

  _updateCurrentTaskProfile((draft) => {
    const localRules = applyReorder(draft.regex?.localRules);
    if (!localRules) return null;
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return { selectRuleId: sourceRuleId };
  });
}

function _persistRegexRuleEnabledById(ruleId, enabled, isGlobal = false, refresh = true) {
  if (!ruleId) return;

  if (isGlobal) {
    _updateGlobalTaskRegex(
      (draft) => {
        const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
        const rule = localRules.find((item) => item.id === ruleId);
        if (!rule) return null;
        rule.enabled = Boolean(enabled);
        draft.localRules = localRules;
        return { selectRuleId: currentGlobalRegexRuleId };
      },
      { refresh },
    );
    return;
  }

  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === ruleId);
      if (!rule) return null;
      rule.enabled = Boolean(enabled);
      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: currentTaskProfileRuleId };
    },
    { refresh },
  );
}

function _persistSelectedBlockField(target, refresh) {
  const field = target.dataset.blockField;
  if (!field) return;

  _updateCurrentTaskProfile(
    (draft, context) => {
      const blocks = _sortTaskBlocks(draft.blocks);
      const block = blocks.find((item) => item.id === currentTaskProfileBlockId);
      if (!block) return null;

      const rawValue =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;

      let extraSettingsPatch = {};
      if (field === "enabled") {
        block.enabled = Boolean(rawValue);
      } else if (field === "content" && block.type === "legacyPrompt") {
        block.content = String(rawValue || "");
        const legacyField = getLegacyPromptFieldForTask(context.taskType);
        if (legacyField) {
          extraSettingsPatch[legacyField] = block.content;
        }
      } else {
        block[field] = String(rawValue || "");
      }

      draft.blocks = _normalizeTaskBlocks(blocks);
      return {
        extraSettingsPatch,
        selectBlockId: block.id,
      };
    },
    { refresh },
  );
}

function _persistGenerationField(target, refresh) {
  const key = target.dataset.generationKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.generation = {
        ...(draft.generation || {}),
        [key]: _parseTaskWorkspaceValue(target, valueType),
      };
    },
    { refresh },
  );
}

function _persistTaskInputField(target, refresh) {
  const key = target.dataset.inputKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.input = {
        ...(draft.input || {}),
        [key]: _parseTaskWorkspaceValue(target, valueType),
      };
    },
    { refresh },
  );
}

function _persistRegexConfigField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        [key]:
          target instanceof HTMLInputElement && target.type === "checkbox"
            ? Boolean(target.checked)
            : target.value,
      };
    },
    { refresh },
  );
}

function _persistRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        sources: {
          ...(draft.regex?.sources || {}),
          [sourceKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        stages: {
          ...(draft.regex?.stages || {}),
          [stageKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistSelectedRegexRuleField(target, refresh) {
  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === currentTaskProfileRuleId);
      if (!rule) return null;

      if (target.dataset.regexRuleField) {
        const field = target.dataset.regexRuleField;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          rule[field] = Boolean(target.checked);
        } else if (["min_depth", "max_depth"].includes(field)) {
          const parsed = Number.parseInt(String(target.value || "").trim(), 10);
          rule[field] = Number.isFinite(parsed) ? parsed : 0;
        } else if (field === "trim_strings") {
          rule[field] = String(target.value || "");
        } else {
          rule[field] = String(target.value || "");
        }
      }

      if (target.dataset.regexRuleSource) {
        const sourceKey = target.dataset.regexRuleSource;
        rule.source = {
          ...(rule.source || {}),
          [sourceKey]: Boolean(target.checked),
        };
      }

      if (target.dataset.regexRuleDestination) {
        const destinationKey = target.dataset.regexRuleDestination;
        rule.destination = {
          ...(rule.destination || {}),
          [destinationKey]: Boolean(target.checked),
        };
      }

      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: rule.id };
    },
    { refresh },
  );
}

function _deleteGlobalRegexRule(ruleId) {
  if (!ruleId) return;
  _updateGlobalTaskRegex((draft) => {
    const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.localRules = localRules;
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _persistGlobalRegexField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft[key] =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;
    },
    { refresh },
  );
}

function _persistGlobalRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.sources = {
        ...(draft.sources || {}),
        [sourceKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistGlobalRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.stages = {
        ...(draft.stages || {}),
        [stageKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistSelectedGlobalRegexRuleField(target, refresh) {
  _updateGlobalTaskRegex(
    (draft) => {
      const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
      const rule = localRules.find((item) => item.id === currentGlobalRegexRuleId);
      if (!rule) return null;

      if (target.dataset.regexRuleField) {
        const field = target.dataset.regexRuleField;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          rule[field] = Boolean(target.checked);
        } else if (["min_depth", "max_depth"].includes(field)) {
          const parsed = Number.parseInt(String(target.value || "").trim(), 10);
          rule[field] = Number.isFinite(parsed) ? parsed : 0;
        } else if (field === "trim_strings") {
          rule[field] = String(target.value || "");
        } else {
          rule[field] = String(target.value || "");
        }
      }

      if (target.dataset.regexRuleSource) {
        const sourceKey = target.dataset.regexRuleSource;
        rule.source = {
          ...(rule.source || {}),
          [sourceKey]: Boolean(target.checked),
        };
      }

      if (target.dataset.regexRuleDestination) {
        const destinationKey = target.dataset.regexRuleDestination;
        rule.destination = {
          ...(rule.destination || {}),
          [destinationKey]: Boolean(target.checked),
        };
      }

      draft.localRules = localRules;
      return { selectRuleId: rule.id };
    },
    { refresh },
  );
}

function _updateCurrentTaskProfile(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const taskProfiles = ensureTaskProfiles(settings);
  const taskType = currentTaskProfileTaskType;
  const bucket = taskProfiles[taskType];
  const activeProfile =
    bucket?.profiles?.find((item) => item.id === bucket.activeProfileId) ||
    bucket?.profiles?.[0];

  if (!activeProfile) return null;

  const draft = _normalizeTaskProfileDraft(_cloneJson(activeProfile));
  const mutationResult = mutator?.(draft, {
      settings,
      taskProfiles,
      taskType,
      bucket,
      activeProfile,
    });

  if (mutationResult === null) return null;

  const result = mutationResult || {};

  const nextProfile = _normalizeTaskProfileDraft(result.profile || draft);
  const nextTaskProfiles = upsertTaskProfile(taskProfiles, taskType, nextProfile, {
    setActive: true,
  });

  if (Object.prototype.hasOwnProperty.call(result, "selectBlockId")) {
    currentTaskProfileBlockId = result.selectBlockId || "";
  }
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentTaskProfileRuleId = result.selectRuleId || "";
  }

  return _patchTaskProfiles(
    nextTaskProfiles,
    result.extraSettingsPatch || {},
    {
      refresh: result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _normalizeTaskProfileDraft(profile = {}) {
  const draft = profile || {};
  draft.blocks = _normalizeTaskBlocks(draft.blocks);
  draft.regex = {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      input: true,
      output: true,
    },
    localRules: [],
    ...(draft.regex || {}),
    sources: {
      global: true,
      preset: true,
      character: true,
      ...(draft.regex?.sources || {}),
    },
    stages: {
      input: true,
      output: true,
      ...normalizeTaskRegexStages(draft.regex?.stages || {}),
    },
    localRules: Array.isArray(draft.regex?.localRules)
      ? draft.regex.localRules.map((rule) => ({
          ...rule,
          source: {
            user_input: true,
            ai_output: true,
            ...(rule?.source || {}),
          },
          destination: {
            prompt: true,
            display: false,
            ...(rule?.destination || {}),
          },
        }))
      : [],
  };
  return draft;
}

function _normalizeTaskBlocks(blocks = []) {
  return _sortTaskBlocks(blocks).map((block, index) => ({
    ...block,
    order: index,
  }));
}

function _sortTaskBlocks(blocks = []) {
  return [...(Array.isArray(blocks) ? blocks : [])].sort((a, b) => {
    const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
    const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
    return orderA - orderB;
  });
}

function _parseTaskWorkspaceValue(target, valueType = "text") {
  if (valueType === "tri_bool") {
    if (target.value === "true") return true;
    if (target.value === "false") return false;
    return null;
  }

  if (valueType === "number") {
    const raw = String(target.value || "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return String(target.value || "").trim();
}

function _isGlobalRegexPanelTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest(".bme-global-regex-panel"));
}

function _normalizeGlobalRegexDraft(regex = {}) {
  const normalized = normalizeGlobalTaskRegex(regex || {}, "global");
  return {
    ...normalized,
    sources: {
      ...(normalized.sources || {}),
    },
    stages: {
      ...normalizeTaskRegexStages(normalized.stages || {}),
    },
    localRules: Array.isArray(normalized.localRules)
      ? normalized.localRules.map((rule, index) =>
          createLocalRegexRule("global", {
            ...rule,
            id: String(rule?.id || `global-rule-${index + 1}`),
          }),
        )
      : [],
  };
}

function _mergeImportedGlobalRegex(currentGlobalRegex = {}, importedGlobalRegex = null) {
  const current = _normalizeGlobalRegexDraft(currentGlobalRegex);
  if (
    !importedGlobalRegex ||
    typeof importedGlobalRegex !== "object" ||
    Array.isArray(importedGlobalRegex)
  ) {
    return {
      globalTaskRegex: current,
      mergedRuleCount: 0,
      replacedConfig: false,
    };
  }

  const imported = _normalizeGlobalRegexDraft(importedGlobalRegex);
  const mergedRules = dedupeRegexRules(
    [
      ...(Array.isArray(current.localRules) ? current.localRules : []),
      ...(Array.isArray(imported.localRules) ? imported.localRules : []),
    ],
    "global",
  );

  return {
    globalTaskRegex: {
      ...imported,
      localRules: mergedRules,
    },
    mergedRuleCount: Math.max(
      0,
      mergedRules.length -
        (Array.isArray(current.localRules) ? current.localRules.length : 0),
    ),
    replacedConfig: true,
  };
}

function _mergeProfileRegexRulesIntoGlobal(
  currentGlobalRegex = {},
  profile = null,
  options = {},
) {
  const merged = migrateLegacyProfileRegexToGlobal(
    _normalizeGlobalRegexDraft(currentGlobalRegex),
    profile,
    options,
  );
  return {
    ...merged,
    globalTaskRegex: _normalizeGlobalRegexDraft(merged.globalTaskRegex || {}),
  };
}

function _renderTaskInputField(field, value) {
  const effectiveValue = value != null && value !== "" ? value : field.defaultValue;

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-input-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === String(effectiveValue ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="number"
        min="0"
        value="${_escAttr(effectiveValue ?? "")}"
        data-input-key="${_escAttr(field.key)}"
        data-value-type="number"
      />
      ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
    </div>
  `;
}

function _patchGlobalTaskRegex(globalTaskRegex, options = {}) {
  return _patchSettings(
    {
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex),
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

function _updateGlobalTaskRegex(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const draft = _normalizeGlobalRegexDraft(_cloneJson(settings.globalTaskRegex || {}));
  const mutationResult = mutator?.(draft, { settings });
  if (mutationResult === null) return null;

  const result = mutationResult || {};
  const nextRegex = _normalizeGlobalRegexDraft(result.globalTaskRegex || draft);
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentGlobalRegexRuleId = result.selectRuleId || "";
  }

  return _patchSettings(
    {
      globalTaskRegex: nextRegex,
      ...(result.extraSettingsPatch || {}),
    },
    {
      refreshTaskWorkspace:
        result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _downloadTaskProfile(taskProfiles, taskType, profile, globalTaskRegex = {}) {
  try {
    const payload = serializeTaskProfile(taskProfiles, taskType, profile?.id || "");
    payload.globalTaskRegex = _normalizeGlobalRegexDraft(globalTaskRegex || {});
    const fileName = _sanitizeFileName(
      `st-bme-${taskType}-${profile?.name || "profile"}.json`,
    );
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success("presetXuấtthành công", "ST-BME");
  } catch (error) {
    console.error("[ST-BME] XuấtPreset tác vụThất bại:", error);
    toastr.error(`presetXuấtThất bại: ${error?.message || error}`, "ST-BME");
  }
}
function _sanitizeFileName(fileName = "profile.json") {
  return String(fileName || "profile.json").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
}

function _downloadAllTaskProfiles(taskProfiles, globalTaskRegex = {}) {
  try {
    const taskTypes = getTaskTypeOptions().map((t) => t.id);
    const profiles = {};
    for (const taskType of taskTypes) {
      try {
        const exported = serializeTaskProfile(taskProfiles, taskType);
        profiles[taskType] = exported;
      } catch {
        // skip missing
      }
    }
    if (Object.keys(profiles).length === 0) {
      toastr.warning("Không có preset nào để xuất", "ST-BME");
      return;
    }
    const payload = {
      format: "st-bme-all-task-profiles",
      version: 1,
      exportedAt: new Date().toISOString(),
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex || {}),
      profiles,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = _sanitizeFileName("st-bme-all-profiles.json");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success(`Đã xuất ${Object.keys(profiles).length} preset tác vụ`, "ST-BME");
  } catch (error) {
    console.error("[ST-BME] XuấtTất cảpresetThất bại:", error);
    toastr.error(`XuấtTất cảpresetThất bại: ${error?.message || error}`, "ST-BME");
  }
}
function _cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function _helpTip(text) {
  if (!text) return "";
  return `<span class="bme-help-tip"><button type="button" class="bme-help-tip__trigger" aria-label="giúp">?</button><span class="bme-help-tip__bubble">${_escHtml(text)}</span></span>`;
}

function _getTaskBlockTypeLabel(type) {
  const typeMap = {
    custom: "Khối tùy chỉnh",
    builtin: "Khối tích hợp",
    legacyPrompt: "Khối tương thích",
  };
  return typeMap[type] || type || "Khối";
}

function _formatTaskProfileTime(raw) {
  if (!raw) return "vừa rồi";
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "vừa rồi";
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "vừa rồi";
  }
}

// ==================== Hàm công cụ ====================

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function _getGraphPersistenceSnapshot() {
  return _getGraphPersistenceState?.() || {
    revision: 0,
    loadState: "no-chat",
    reason: "",
    writesBlocked: true,
    shadowSnapshotUsed: false,
    pendingPersist: false,
    lastAcceptedRevision: 0,
    hostProfile: "generic-st",
    primaryStorageTier: "indexeddb",
    cacheStorageTier: "none",
    cacheMirrorState: "idle",
    cacheLag: 0,
    acceptedBy: "none",
    persistDiagnosticTier: "none",
    persistMismatchReason: "",
    commitMarker: null,
    lukerSidecarFormatVersion: 0,
    lukerManifestRevision: 0,
    lukerJournalDepth: 0,
    lukerJournalBytes: 0,
    lukerCheckpointRevision: 0,
    chatId: "",
    storageMode: "indexeddb",
    resolvedLocalStore: "indexeddb:indexeddb",
    localStoreFormatVersion: 1,
    localStoreMigrationState: "idle",
    opfsWriteLockState: null,
    opfsWalDepth: 0,
    opfsPendingBytes: 0,
    opfsCompactionState: null,
    remoteSyncFormatVersion: 1,
    dbReady: false,
    syncState: "idle",
    syncDirty: false,
    syncDirtyReason: "",
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    lastSyncError: "",
    persistDelta: null,
  };
}

function _getLatestBatchStatusSnapshot() {
  return _getLastBatchStatus?.() || null;
}

function _formatPersistenceOutcomeLabel(outcome = "") {
  switch (String(outcome || "")) {
    case "saved":
      return "Đã lưu";
    case "fallback":
      return "Bản lưu lùi đã xong";
    case "not-attempted":
      return "Chưa thử";
    case "queued":
      return "Đã xếp hàng";
    case "blocked":
      return "Đã chặn";
    case "failed":
      return "Thất bại";
    case "recoverable":
      return "Đã bắt được neo khôi phục";
    default:
      return "Không rõ";
  }
}

function _formatPersistMismatchReason(reason = "") {
  const normalized = String(reason || "").trim();
  if (!normalized) return "—";
  switch (normalized) {
    case "persist-mismatch:indexeddb-behind-commit-marker":
      return "Phiên bản lưu trữ đồ thị cục bộ đang chậm hơn phiên bản đã xác nhận của chat hiện tại";
    default:
      return normalized;
  }
}

function _formatPersistMismatchHelp(reason = "") {
  const normalized = String(reason || "").trim();
  switch (normalized) {
    case "persist-mismatch:indexeddb-behind-commit-marker":
      return "Bản ghi hiển thị của chat hiện tại cho thấy đồ thị đã được xác nhận lên phiên bản cao hơn, nhưng trong lưu trữ cục bộ OPFS / IndexedDB vẫn chưa có dữ liệu tương ứng. Tình huống này thường gặp ngay sau khi vừa xóa bộ đệm cục bộ hoặc khi bước xác nhận ghi vẫn chưa hoàn tất. Hãy thử bấm “Thăm dò lại đồ thị” trước; nếu vẫn bất thường thì bấm “Thử lưu bền lại” hoặc chạy xây lại/khôi phục.";
    default:
      return `Phát hiện lưu bền bất thường về tính nhất quán: ${_formatPersistMismatchReason(normalized)}. Hãy thăm dò lại đồ thị trước; nếu vẫn bất thường thì hãy xây lại hoặc khôi phục.`;
  }
}

function _hasMeaningfulPersistenceRecord(persistence = null) {
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

function _isPersistenceRevisionAccepted(persistence = null, loadInfo = {}) {
  if (!persistence || persistence.accepted === true) return true;
  if (!_hasMeaningfulPersistenceRecord(persistence)) return true;
  if (loadInfo?.pendingPersist === true) return false;
  const persistenceRevision = Number(persistence?.revision || 0);
  if (!Number.isFinite(persistenceRevision) || persistenceRevision <= 0) {
    return false;
  }
  const lastAcceptedRevision = Number(loadInfo?.lastAcceptedRevision || 0);
  return Number.isFinite(lastAcceptedRevision) && lastAcceptedRevision >= persistenceRevision;
}

function _formatDashboardPersistMeta(loadInfo = {}, batchStatus = null) {
  const persistence = batchStatus?.persistence || null;
  const localPersistError = String(loadInfo?.indexedDbLastError || "").trim();
  if (_hasMeaningfulPersistenceRecord(persistence)) {
    const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
    const parts = [
      accepted
        ? "Đã xác nhận"
        : persistence.recoverable === true
          ? "Đã bắt được neo khôi phục"
          : _formatPersistenceOutcomeLabel(persistence.outcome),
      persistence.storageTier ? `tier ${persistence.storageTier}` : "",
      Number.isFinite(Number(persistence.revision)) && Number(persistence.revision) > 0
        ? `rev ${Number(persistence.revision)}`
        : "",
      persistence.reason || "",
      !accepted && localPersistError ? `Cục bộLỗi ${localPersistError}` : "",
    ].filter(Boolean);
    return parts.join(" · ") || "Vẫn chưa có bản ghi lưu bền";
  }

  const dualWrite = loadInfo?.dualWriteLastResult || null;
  if (dualWrite) {
    return [
      dualWrite.success === true ? "Gần nhấtghi vàothành công" : "Gần nhấtghi vàoThất bại",
      dualWrite.target || dualWrite.source || "",
      Number.isFinite(Number(dualWrite.revision)) && Number(dualWrite.revision) > 0
        ? `rev ${Number(dualWrite.revision)}`
        : "",
      _formatPersistMismatchReason(dualWrite.reason || dualWrite.error || ""),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (loadInfo?.persistMismatchReason) {
    return `Bất thường nhất quán · ${_formatPersistMismatchReason(loadInfo.persistMismatchReason)}`;
  }

  if (String(batchStatus?.outcome || "") === "failed") {
    return "Lô này chưa đi vào lưu bền";
  }

  return "vẫn chưathực thiLưu bền";
}

function _formatDashboardHistoryMeta(graph = null, loadInfo = {}, batchStatus = null) {
  const lastConfirmedFloor =
    graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const persistence = batchStatus?.persistence || null;
  const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
  const localPersistError = String(loadInfo?.indexedDbLastError || "").trim();
  const processedRange = Array.isArray(batchStatus?.processedRange)
    ? batchStatus.processedRange
    : [];
  const pendingFloor =
    processedRange.length > 1 && Number.isFinite(Number(processedRange[1]))
      ? Number(processedRange[1])
      : null;

  if (_hasMeaningfulPersistenceRecord(persistence) && !accepted && pendingFloor != null) {
    return `Lưu bền đang chờ xác nhận: cục bộ đã trích xuất tới tầng ${pendingFloor}, đã xác nhận tới tầng ${lastConfirmedFloor}${localPersistError ? ` · Lỗi cục bộ ${localPersistError}` : ""}`;
  }

  if (loadInfo?.persistMismatchReason) {
    return `Lưu bền bất thường về tính nhất quán: ${_formatPersistMismatchReason(loadInfo.persistMismatchReason)} · đã xác nhận tới tầng ${lastConfirmedFloor}`;
  }

  if (String(batchStatus?.outcome || "") === "failed") {
    return `Lô trích xuất gần nhất đã thất bại, đã xử lý xác nhận tới tầng ${lastConfirmedFloor}`;
  }

  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  if (Number.isFinite(dirtyFrom)) {
    return `Vùng bẩn bắt đầu từ tầng ${dirtyFrom}, đã xử lý xác nhận tới tầng ${lastConfirmedFloor}`;
  }

  return `Sạch, đã xử lý xác nhận tới tầng ${lastConfirmedFloor}`;
}

function _getGraphLoadLabel(loadInfoOrState = "") {
  const loadInfo =
    loadInfoOrState && typeof loadInfoOrState === "object"
      ? loadInfoOrState
      : null;
  const loadState = String(
    loadInfo ? loadInfo.loadState || "" : loadInfoOrState || "",
  );
  switch (loadState) {
    case "loading":
      return loadInfo?.runtimeGraphReadable === true
        ? "Đồ thị đã được nạp tạm, đang xác nhận lưu trữ cục bộ"
        : "Đang tải đồ thị của chat hiện tại";
    case "shadow-restored":
      return "Đã khôi phục từ snapshot tạm thời của phiên hiện tại, đang chờ chatMetadata chính thức";
    case "empty-confirmed":
      return "Chat hiện tại vẫn chưa có đồ thị";
    case "blocked":
      return "Đồ thị của chat hiện tại chưa thể hoàn tất xác nhận lưu bền chính thức, vui lòng thử lại sau";
    case "loaded":
      return "chatđồ thịĐã tải";
    case "no-chat":
    default:
      return "Hiện chưa vào cuộc chat";
  }
}

function _refreshPersistenceRepairUi(
  loadInfo = _getGraphPersistenceSnapshot(),
  batchStatus = _getLatestBatchStatusSnapshot(),
) {
  const help = document.getElementById("bme-persist-repair-help");
  const lukerGroup = document.getElementById("bme-luker-sidecar-group");
  const actionHelp = document.getElementById("bme-actions-persist-repair-help");
  const lukerCacheBtn = document.getElementById("bme-act-rebuild-luker-cache");
  const lukerRepairBtn = document.getElementById("bme-act-repair-luker-sidecar");
  const lukerCompactBtn = document.getElementById("bme-act-compact-luker-sidecar");
  const retryBtn = document.getElementById("bme-act-retry-persist");
  const probeBtn = document.getElementById("bme-act-probe-graph-load");
  if (!help) return;

  const persistence = batchStatus?.persistence || null;
  const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
  const shouldShow =
    loadInfo?.pendingPersist === true ||
    Boolean(loadInfo?.persistMismatchReason) ||
    (_hasMeaningfulPersistenceRecord(persistence) && !accepted);

  help.hidden = !shouldShow;
  const isLuker = String(loadInfo?.hostProfile || "") === "luker";
  if (lukerGroup) lukerGroup.hidden = false;
  if (retryBtn) retryBtn.hidden = false;
  if (probeBtn) probeBtn.hidden = false;
  if (lukerCacheBtn) lukerCacheBtn.hidden = !isLuker;
  if (lukerRepairBtn) lukerRepairBtn.hidden = !isLuker;
  if (lukerCompactBtn) lukerCompactBtn.hidden = !isLuker;
  if (!shouldShow) {
    help.textContent = "";
    if (actionHelp) {
      actionHelp.textContent = isLuker
        ? "Khu vực này tập trung các lối sửa lưu bền. Trường hợp thường gặp hãy dùng “Thử lưu bền lại” và “Thăm dò lại đồ thị” trước; nếu sidecar chính của Luker bị lệch thì mới dùng 3 nút sửa chuyên sâu bên phải."
        : "Khu vực này tập trung các lối sửa lưu bền. Thông thường hãy thử “Thử lưu bền lại” trước, nếu trạng thái chưa khôi phục thì thử tiếp “Thăm dò lại đồ thị”.";
    }
    return;
  }

  let helpText = "";
  if (loadInfo?.pendingPersist === true) {
    helpText =
      isLuker
        ? "Lô trích xuất gần nhất đã hoàn tất nhưng manifest Luker vẫn chưa xác nhận. Hãy thử “Thử lưu bền lại” trước; nếu vẫn chưa xác nhận thì sang khu vực Luker Sidecar ở trang “Thao tác” để chạy “Sửa Sidecar chính” hoặc “Xây lại bộ đệm cục bộ”."
        : "Lô trích xuất gần nhất đã hoàn tất nhưng ghi ngược chính thức vẫn chưa được xác nhận. Hãy thử “Thử lưu bền lại” trước; nếu trạng thái không đổi thì thử tiếp “Thăm dò lại đồ thị”.";
    if (loadInfo?.indexedDbLastError) {
      helpText = `${helpText}\nCục bộLỗi：${loadInfo.indexedDbLastError}`;
    }
  } else if (loadInfo?.persistMismatchReason) {
    helpText = _formatPersistMismatchHelp(loadInfo.persistMismatchReason);
  } else {
    helpText =
      persistence?.recoverable === true
        ? isLuker
          ? "Lô gần nhất đã bắt được neo khôi phục nhưng sidecar chính của Luker vẫn chưa xác nhận. Có thể thử “Thử lưu bền lại” trước; khi cần thì vào khu vực sửa lưu bền của trang “Thao tác” để chạy bản sửa sâu hơn."
          : "Lô gần nhất đã bắt được neo khôi phục nhưng vẫn chưa đi vào vùng lưu trữ accepted chính thức. Có thể thử “Thử lưu bền lại” trước; nếu vẫn chưa xác nhận thì hãy thăm dò lại đồ thị."
        : isLuker
          ? "Lô lưu bền gần nhất chưa được Luker manifest chấp nhận. Có thể thử “Thử lưu bền lại” trước; nếu sidecar chính bị lệch với bộ đệm cục bộ thì sang khu vực sửa lưu bền ở trang “Thao tác” để chạy bản sửa sâu hơn."
          : "Lô lưu bền gần nhất chưa được chấp nhận. Có thể thử “Thử lưu bền lại” trước; nếu host tải lưu trữ cục bộ bị trễ thì hãy thăm dò lại đồ thị.";
  }
  help.textContent = helpText;
  if (actionHelp) {
    actionHelp.textContent = helpText;
  }
}

function _canRenderGraphData(loadInfo = _getGraphPersistenceSnapshot()) {
  return (
    loadInfo.dbReady === true ||
    loadInfo.loadState === "loaded" ||
    loadInfo.loadState === "empty-confirmed" ||
    loadInfo.shadowSnapshotUsed === true
  );
}

function _isGraphWriteBlocked(loadInfo = _getGraphPersistenceSnapshot()) {
  if (typeof loadInfo.dbReady === "boolean" && !loadInfo.dbReady) {
    return true;
  }
  return Boolean(loadInfo.writesBlocked);
}

function _renderStatefulListPlaceholder(listEl, text) {
  if (!listEl) return;
  const li = document.createElement("li");
  li.className = "bme-recent-item";
  const content = document.createElement("div");
  content.className = "bme-recent-text";
  content.style.color = "var(--bme-on-surface-dim)";
  content.textContent = text;
  li.appendChild(content);
  listEl.replaceChildren(li);
}

function _refreshGraphAvailabilityState() {
  const loadInfo = _getGraphPersistenceSnapshot();
  const banner = document.getElementById("bme-action-guard-banner");
  const graphOverlay = document.getElementById("bme-graph-overlay");
  const graphOverlayText = document.getElementById("bme-graph-overlay-text");
  const mobileOverlay = document.getElementById("bme-mobile-graph-overlay");
  const mobileOverlayText = document.getElementById("bme-mobile-graph-overlay-text");
  const blocked = _isGraphWriteBlocked(loadInfo);
  const loadLabel = _getGraphLoadLabel(loadInfo);
  const pausedLabel = "Kết xuất đồ thị đã tạm dừng, bạn có thể nhấn nút trên thanh công cụ để khôi phục.";
  const renderingPaused = !_isGraphRenderingEnabled();

  GRAPH_WRITE_ACTION_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = blocked;
    button.classList.toggle("is-runtime-disabled", blocked);
    button.title = blocked ? loadLabel : "";
  });
  _refreshGraphRenderToggleUi();

  if (banner) {
    const shouldShowBanner = blocked;
    banner.hidden = !shouldShowBanner;
    banner.textContent = shouldShowBanner ? loadLabel : "";
  }

  const shouldShowRuntimeOverlay =
    blocked ||
    loadInfo.syncState === "syncing" ||
    loadInfo.loadState === "loading" ||
    loadInfo.loadState === "shadow-restored" ||
    loadInfo.loadState === "blocked";

  const shouldShowOverlay = shouldShowRuntimeOverlay || renderingPaused;
  const overlayLabel = shouldShowRuntimeOverlay
    ? loadLabel
    : renderingPaused
      ? pausedLabel
      : "";

  if (graphOverlay) {
    graphOverlay.hidden = !shouldShowOverlay;
    graphOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (graphOverlayText) {
    graphOverlayText.textContent = overlayLabel;
  }
  if (mobileOverlay) {
    mobileOverlay.hidden = !shouldShowOverlay;
    mobileOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (mobileOverlayText) {
    mobileOverlayText.textContent = overlayLabel;
  }

  _refreshGraphLayoutDiagnosticsUi();
}

function _formatCloudTimeLabel(timestamp) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";
  try {
    return new Date(normalized).toLocaleString();
  } catch {
    return "";
  }
}

function _renderCloudStorageModeStatus(
  settings = _getSettings?.() || {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const statusEl = document.getElementById("bme-cloud-storage-mode-status");
  if (!statusEl) return;

  const mode = String(settings?.cloudStorageMode || "automatic");
  if (mode !== "manual") {
    statusEl.style.display = "none";
    statusEl.textContent = "";
    return;
  }

  const lines = [];
  const syncDirty = Boolean(loadInfo?.syncDirty);
  const dirtyReason = String(loadInfo?.syncDirtyReason || "").trim();
  const backupUploadedAt = Number(loadInfo?.lastBackupUploadedAt) || 0;
  const backupRestoredAt = Number(loadInfo?.lastBackupRestoredAt) || 0;
  const backupRollbackAt = Number(loadInfo?.lastBackupRollbackAt) || 0;
  const backupFilename = String(loadInfo?.lastBackupFilename || "").trim();
  const dualWrite = loadInfo?.dualWriteLastResult || null;
  const dualWriteAt = Number(dualWrite?.at) || 0;
  const needsPostRecoveryBackup =
    Boolean(dualWrite?.success) &&
    ["migration", "identity-recovery"].includes(String(dualWrite?.action || "")) &&
    dualWriteAt > backupUploadedAt;

  if (syncDirty) {
    lines.push(
      dirtyReason
        ? `\u672c\u5730\u6709\u672a\u5907\u4efd\u7684\u6539\u52a8\uff0c\u7b49\u5f85\u4f60\u624b\u52a8\u4e0a\u4f20\u3002\u539f\u56e0\uff1a${dirtyReason}`
        : "\u672c\u5730\u6709\u672a\u5907\u4efd\u7684\u6539\u52a8\uff0c\u7b49\u5f85\u4f60\u624b\u52a8\u4e0a\u4f20\u3002",
    );
  } else if (backupUploadedAt > 0) {
    const uploadedAtText = _formatCloudTimeLabel(backupUploadedAt);
    lines.push(
      uploadedAtText
        ? `\u4e0a\u6b21\u5907\u4efd\u4e8e ${uploadedAtText}${backupFilename ? `\uff0c\u6587\u4ef6\uff1a${backupFilename}` : ""}`
        : "\u5f53\u524d\u804a\u5929\u5df2\u6709\u4e91\u7aef\u5907\u4efd\u8bb0\u5f55\u3002",
    );
  } else {
    lines.push("\u8fd8\u6ca1\u6709\u4e3a\u5f53\u524d\u804a\u5929\u4e0a\u4f20\u8fc7\u624b\u52a8\u5907\u4efd\u3002");
  }

  if (backupRestoredAt > 0) {
    const restoredAtText = _formatCloudTimeLabel(backupRestoredAt);
    if (restoredAtText) {
      lines.push(`\u4e0a\u6b21\u4ece\u4e91\u7aef\u6062\u590d\u4e8e ${restoredAtText}${backupFilename ? `\uff0c\u6587\u4ef6\uff1a${backupFilename}` : ""}`);
    }
  }

  if (backupRollbackAt > 0) {
    const rollbackAtText = _formatCloudTimeLabel(backupRollbackAt);
    if (rollbackAtText) {
      lines.push(`\u6700\u8fd1\u4e00\u6b21\u5df2\u56de\u6eda\u5230\u6062\u590d\u524d\u7684\u672c\u5730\u5feb\u7167\uff0c\u65f6\u95f4\uff1a${rollbackAtText}`);
    }
  }

  if (needsPostRecoveryBackup) {
    const actionLabel =
      String(dualWrite?.action || "") === "identity-recovery"
        ? "\u8eab\u4efd\u6062\u590d"
        : "\u8fc1\u79fb";
    lines.push(`\u5df2\u5b8c\u6210${actionLabel}\uff0c\u4f46\u4e91\u7aef\u5907\u4efd\u8fd8\u6ca1\u8ddf\u4e0a\u8fd9\u6b21\u53d8\u66f4\u3002\u5982\u679c\u4f60\u8981\u5728 A/B \u8bbe\u5907\u95f4\u63a5\u529b\uff0c\u8bf7\u518d\u70b9\u4e00\u6b21\u201c\u5907\u4efd\u5230\u4e91\u7aef\u201d\u3002`);
  }

  statusEl.style.display = lines.length ? "" : "none";
  statusEl.innerHTML = lines.map((line) => `<div>${_escHtml(line)}</div>`).join("");
}

async function _refreshCloudBackupManualUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const rollbackButton = document.getElementById("bme-act-rollback-last-restore");
  if (!rollbackButton) return;

  if (mode !== "manual") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  if (typeof _actionHandlers.getRestoreSafetyStatus !== "function") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  rollbackButton.disabled = true;
  rollbackButton.title = "\u6b63\u5728\u68c0\u67e5\u662f\u5426\u5b58\u5728\u53ef\u7528\u7684\u56de\u6eda\u5feb\u7167...";
  try {
    const status = await _actionHandlers.getRestoreSafetyStatus();
    const hasSafety = Boolean(status?.exists);
    rollbackButton.disabled = !hasSafety;
    rollbackButton.title = hasSafety
      ? status?.createdAt
        ? `\u5df2\u68c0\u6d4b\u5230\u4e0a\u6b21\u6062\u590d\u524d\u7684\u672c\u5730\u5b89\u5168\u5feb\u7167\uff0c\u521b\u5efa\u65f6\u95f4\uff1a${new Date(status.createdAt).toLocaleString()}`
        : "\u5df2\u68c0\u6d4b\u5230\u4e0a\u6b21\u6062\u590d\u524d\u7684\u672c\u5730\u5b89\u5168\u5feb\u7167\uff0c\u53ef\u4ee5\u56de\u6eda\u3002"
      : "\u5f53\u524d\u804a\u5929\u8fd8\u6ca1\u6709\u53ef\u7528\u7684\u56de\u6eda\u5feb\u7167\u3002";
  } catch (error) {
    console.error("[ST-BME] failed to read restore safety snapshot status:", error);
    rollbackButton.disabled = true;
    rollbackButton.title = "\u8bfb\u53d6\u56de\u6eda\u5feb\u7167\u72b6\u6001\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002";
  }
}

function _refreshCloudStorageModeUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const manualActions = document.getElementById(
    "bme-cloud-backup-manual-actions",
  );
  const helpText = document.getElementById("bme-cloud-storage-mode-help");
  if (manualActions) {
    manualActions.style.display = mode === "manual" ? "" : "none";
  }
  if (helpText) {
    helpText.textContent =
      mode === "manual"
        ? "\u624b\u52a8\u50a8\u5b58\u53ea\u4fdd\u7559\u672c\u5730 OPFS / IndexedDB \u5199\u5165\uff0c\u4e0d\u4f1a\u81ea\u52a8\u4e0a\u4f20\u6216\u8986\u76d6\u4e91\u7aef\u3002\u9700\u8981\u63a5\u529b\u65f6\uff0c\u8bf7\u624b\u52a8\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u3002"
        : "\u81ea\u52a8\u50a8\u5b58\u4f1a\u7ee7\u7eed\u6cbf\u7528\u5f53\u524d\u955c\u50cf\u540c\u6b65\u903b\u8f91\u4e0e\u95f4\u9694\uff1b\u624b\u52a8\u50a8\u5b58\u53ea\u4fdd\u7559\u672c\u5730\u5199\u5165\uff0c\u9700\u8981\u4f60\u4e3b\u52a8\u5907\u4efd\u548c\u6062\u590d\u3002";
  }
  _renderCloudStorageModeStatus(settings, _getGraphPersistenceSnapshot());
  void _refreshCloudBackupManualUi(settings);
}

function _refreshRuntimeStatus() {
  const runtimeStatus = _getRuntimeStatus?.() || {};
  const text = runtimeStatus.text || "Chờ";
  const meta = runtimeStatus.meta || "chuẩn bịsẵn sàng";
  _setText("bme-status-text", text);
  _setText("bme-status-meta", meta);
  _setText("bme-mobile-status-text", text);
  _setText("bme-mobile-status-meta", meta);
  _setText("bme-panel-status", text);
  _renderCloudStorageModeStatus(_getSettings?.() || {}, _getGraphPersistenceSnapshot());
  _refreshGraphAvailabilityState();
}

function _showActionProgressUi(label, meta = "Vui lòng chờ...") {
  _setText("bme-status-text", `${label}Trung bình`);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", `${label}Trung bình`);
  updateFloatingBallStatus("running", `${label}Trung bình`);
}

function _syncFloatingBallWithRuntimeStatus() {
  const status = _getRuntimeStatus?.() || {};
  const level = String(status.level || "idle");
  const fabStatus = level === "info" ? "idle" : level;
  updateFloatingBallStatus(fabStatus, status.text || "BME đồ thị ký ức");
}

function _patchSettings(patch = {}, options = {}) {
  const settings = _updateSettings?.(patch) || _getSettings?.() || {};
  if (options.refreshGuards) _refreshGuardedConfigStates(settings);
  if (options.refreshPrompts) _refreshPromptCardStates(settings);
  if (options.refreshTaskWorkspace) _refreshTaskProfileWorkspace(settings);
  if (options.refreshTheme)
    _highlightThemeChoice(settings.panelTheme || "crimson");
  _refreshCloudStorageModeUi(settings);
  return settings;
}

function _formatBackupManagerTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) {
    return "\u672a\u8bb0\u5f55";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "\u672a\u8bb0\u5f55";
  }
}

function _buildCloudBackupManagerHtml(state = {}) {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const currentChatId = String(state.currentChatId || "").trim();
  if (state.loading) {
    return `
      <div class="bme-cloud-backup-modal__loading">
        <i class="fa-solid fa-spinner fa-spin"></i> \u6b63\u5728\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868...
      </div>
    `;
  }

  if (!entries.length) {
    return `
      <div class="bme-cloud-backup-modal__empty">
        \u670d\u52a1\u5668\u4e0a\u8fd8\u6ca1\u6709 ST-BME \u5907\u4efd\u3002<br />
        \u5148\u5728\u5f53\u524d\u804a\u5929\u70b9\u4e00\u6b21\u201c\u5907\u4efd\u5230\u4e91\u7aef\u201d\u5c31\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002
      </div>
    `;
  }

  return entries
    .map((entry) => {
      const chatId = String(entry?.chatId || "").trim();
      const filename = String(entry?.filename || "").trim();
      const isCurrentChat = currentChatId && chatId === currentChatId;
      const backupTime = _formatBackupManagerTime(entry?.backupTime);
      const lastModified = _formatBackupManagerTime(entry?.lastModified);
      const sizeLabel =
        Number.isFinite(Number(entry?.size)) && Number(entry.size) > 0
          ? `${Number(entry.size)} B`
          : "\u672a\u77e5\u5927\u5c0f";
      return `
        <div class="bme-cloud-backup-card ${isCurrentChat ? "is-current-chat" : ""}">
          <div class="bme-cloud-backup-card__top">
            <div class="bme-cloud-backup-card__title">${_escHtml(chatId || "(unknown chat)")}</div>
            ${isCurrentChat ? '<div class="bme-cloud-backup-card__badge"><i class="fa-solid fa-location-dot"></i><span>\u5f53\u524d\u804a\u5929</span></div>' : ""}
          </div>
          <div class="bme-cloud-backup-card__meta">
            <div>Revision: ${_escHtml(String(entry?.revision ?? 0))}</div>
            <div>\u5907\u4efd\u65f6\u95f4: ${_escHtml(backupTime)}</div>
            <div>\u6700\u540e\u4fee\u6539: ${_escHtml(lastModified)}</div>
            <div>\u6587\u4ef6\u5927\u5c0f: ${_escHtml(sizeLabel)}</div>
          </div>
          <div class="bme-cloud-backup-card__filename">${_escHtml(filename)}</div>
          <div class="bme-cloud-backup-card__actions">
          <button
              type="button"
              class="bme-cloud-backup-modal__btn bme-cloud-backup-card__danger"
              data-bme-backup-action="delete"
              data-chat-id="${_escHtml(chatId)}"
              data-filename="${_escHtml(filename)}"
              data-server-path="${_escHtml(String(entry?.serverPath || ""))}"
              ${state.busy ? "disabled" : ""}
            >
              <i class="fa-solid fa-trash-can"></i>
              <span>\u5220\u9664\u5907\u4efd</span>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function _openServerBackupManagerModal() {
  if (typeof _actionHandlers.manageServerBackups !== "function") {
    toastr.info("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u670d\u52a1\u5668\u5907\u4efd\u7ba1\u7406\u5165\u53e3", "ST-BME");
    return { handledToast: true, skipDashboardRefresh: true };
  }

  _ensureCloudBackupManagerStyles();
  const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
  const state = {
    loading: true,
    busy: false,
    entries: [],
    currentChatId: "",
  };

  const container = document.createElement("div");
  container.className = "bme-cloud-backup-modal";
  container.innerHTML = `
    <div class="bme-cloud-backup-modal__header">
      <div>
        <div class="bme-cloud-backup-modal__title">\u7ba1\u7406\u670d\u52a1\u5668\u5907\u4efd</div>
        <div class="bme-cloud-backup-modal__subtitle">
          \u8fd9\u91cc\u5c55\u793a\u7684\u662f\u624b\u52a8\u5907\u4efd\u6587\u4ef6\uff0c\u4e0d\u4f1a\u628a\u81ea\u52a8\u540c\u6b65\u955c\u50cf\u6df7\u8fdb\u6765\u3002<br />
          \u5220\u9664\u64cd\u4f5c\u53ea\u5f71\u54cd\u4e91\u7aef\u5907\u4efd\uff0c\u4e0d\u4f1a\u6539\u52a8\u5f53\u524d\u8bbe\u5907\u7684\u672c\u5730 IndexedDB\u3002
        </div>
      </div>
      <div class="bme-cloud-backup-modal__tools">
        <button type="button" class="bme-cloud-backup-modal__btn" data-bme-backup-action="refresh">
          <i class="fa-solid fa-rotate"></i>
          <span>\u5237\u65b0\u5217\u8868</span>
        </button>
      </div>
    </div>
    <div class="bme-cloud-backup-modal__list"></div>
  `;

  const listEl = container.querySelector(".bme-cloud-backup-modal__list");
  const render = () => {
    if (!listEl) return;
    listEl.innerHTML = _buildCloudBackupManagerHtml(state);
    const refreshBtn = container.querySelector('[data-bme-backup-action="refresh"]');
    if (refreshBtn) refreshBtn.disabled = Boolean(state.busy || state.loading);
  };

  const refreshEntries = async ({ showToast = false } = {}) => {
    state.loading = true;
    render();
    try {
      const result = await _actionHandlers.manageServerBackups();
      state.entries = Array.isArray(result?.entries) ? result.entries : [];
      state.currentChatId = String(result?.currentChatId || "").trim();
      if (showToast) {
        toastr.success("\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868\u5df2\u5237\u65b0", "ST-BME");
      }
    } catch (error) {
      console.error("[ST-BME] failed to load server backups:", error);
      toastr.error(`\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.loading = false;
      render();
    }
  };

  const deleteEntry = async (chatId, filename, serverPath = "") => {
    if (typeof _actionHandlers.deleteServerBackupEntry !== "function") {
      toastr.error("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\u5165\u53e3", "ST-BME");
      return;
    }

    if (!globalThis.confirm?.(`\u786e\u5b9a\u8981\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd ${filename} \u5417\uff1f\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\u3002`)) {
      return;
    }

    state.busy = true;
    render();
    try {
      const result = await _actionHandlers.deleteServerBackupEntry({
        chatId,
        filename,
        serverPath,
      });
      if (!result?.deleted) {
        const message =
          result?.reason === "delete-backup-manifest-error"
            ? result?.backupDeleted
              ? "\u5907\u4efd\u6587\u4ef6\u5df2\u5220\u9664\uff0c\u4f46\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
              : "\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
            : `\u5220\u9664\u5931\u8d25: ${result?.error?.message || result?.reason || "\u672a\u77e5\u539f\u56e0"}`;
        toastr.error(message, "ST-BME");
        return;
      }
      toastr.success(`\u5df2\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\uff1a${filename}`, "ST-BME");
      await refreshEntries();
    } catch (error) {
      console.error("[ST-BME] failed to delete server backup:", error);
      toastr.error(`\u5220\u9664\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.busy = false;
      render();
      _refreshRuntimeStatus();
      void _refreshCloudBackupManualUi();
    }
  };

  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-bme-backup-action]");
    if (!button || button.disabled) return;
    const action = String(button.dataset.bmeBackupAction || "");
    if (action === "refresh") {
      await refreshEntries({ showToast: true });
      return;
    }
    if (action === "delete") {
      await deleteEntry(
        String(button.dataset.chatId || "").trim(),
        String(button.dataset.filename || "").trim(),
        String(button.dataset.serverPath || "").trim(),
      );
    }
  });

  await refreshEntries();
  await callGenericPopup(container, POPUP_TYPE.TEXT, "", {
    okButton: "\u5173\u95ed",
    wide: true,
    large: true,
    allowVerticalScrolling: true,
  });
  return { handledToast: true, skipDashboardRefresh: true };
}

function _normalizeLlmPresetSettings(settings = _getSettings?.() || {}) {
  const normalized = sanitizeLlmPresetSettings(settings);

  if (!normalized.changed) {
    return settings;
  }

  return _patchSettings({
    llmPresets: normalized.presets,
    llmActivePreset: normalized.activePreset,
  }, {
    refreshTaskWorkspace: true,
  });
}

function _resolveAndPersistActiveLlmPreset(settings = _getSettings?.() || {}) {
  const normalizedSettings = _normalizeLlmPresetSettings(settings);
  const resolvedActivePreset = resolveActiveLlmPresetName(normalizedSettings);
  if (
    resolvedActivePreset !==
    String(normalizedSettings?.llmActivePreset || "")
  ) {
    return _patchSettings({ llmActivePreset: resolvedActivePreset });
  }
  return normalizedSettings;
}

function _getLlmConfigInputSnapshot() {
  const settings = _getSettings?.() || {};
  return {
    llmApiUrl: String(
      document.getElementById("bme-setting-llm-url")?.value ?? settings.llmApiUrl ?? "",
    ).trim(),
    llmApiKey: String(
      document.getElementById("bme-setting-llm-key")?.value ?? settings.llmApiKey ?? "",
    ).trim(),
    llmModel: String(
      document.getElementById("bme-setting-llm-model")?.value ?? settings.llmModel ?? "",
    ).trim(),
  };
}

function _populateLlmPresetSelect(presets = {}, activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (!select) return;

  while (select.options.length > 1) {
    select.remove(1);
  }

  Object.keys(presets)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

  select.value = activePreset || "";
}

function _syncLlmPresetControls(activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (select) {
    select.value = activePreset || "";
  }

  const deleteBtn = document.getElementById("bme-llm-preset-delete");
  if (deleteBtn) {
    deleteBtn.disabled = !activePreset;
    deleteBtn.title = activePreset ? "Xóa preset hiện tại" : "Ở chế độ thủ công không có preset nào để xóa";
  }
}

function _clearFetchedLlmModels() {
  fetchedMemoryLLMModels.length = 0;
  const modelSelect = document.getElementById("bme-select-llm-model");
  if (!modelSelect) return;
  while (modelSelect.options.length > 1) {
    modelSelect.remove(1);
  }
  modelSelect.value = "";
  modelSelect.style.display = "none";
}

function _markLlmPresetDirty(options = {}) {
  if (options.clearFetchedModels) {
    _clearFetchedLlmModels();
  }

  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  _syncLlmPresetControls(String(settings?.llmActivePreset || ""));
}

function _highlightThemeChoice(themeName) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-theme-option").forEach((opt) => {
    opt.classList.toggle("active", opt.dataset.theme === themeName);
  });
  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.theme === themeName);
  });
}

function _refreshGuardedConfigStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-guarded-card").forEach((card) => {
    const guardKeys = String(card.dataset.guardSettings || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const enabled = guardKeys.every((key) => Boolean(settings[key]));
    card.classList.toggle("is-disabled", !enabled);
    const note = card.querySelector(".bme-config-guard-note");
    note?.classList.toggle("visible", !enabled);
    card
      .querySelectorAll("input, select, textarea, button")
      .forEach((element) => {
        element.disabled = !enabled;
      });
  });
}

function _refreshStageCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-stage-card").forEach((card) => {
    const toggleId = card.dataset.stageToggleId;
    const toggle = toggleId ? document.getElementById(toggleId) : null;
    const cardDisabled = card.classList.contains("is-disabled");
    const stageEnabled =
      toggleId === "bme-setting-recall-llm"
        ? (settings.recallEnableLLM ?? true)
        : toggle
          ? Boolean(toggle.checked)
          : true;

    card.classList.toggle("stage-disabled", !cardDisabled && !stageEnabled);
    card.querySelectorAll(".bme-stage-param").forEach((section) => {
      section
        .querySelectorAll("input, select, textarea, button")
        .forEach((element) => {
          element.disabled = cardDisabled || !stageEnabled;
        });
    });
  });
}

function _refreshFetchedModelSelects(settings = _getSettings?.() || {}) {
  _renderFetchedModelOptions(
    "bme-select-llm-model",
    fetchedMemoryLLMModels,
    settings.llmModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-backend-model",
    fetchedBackendEmbeddingModels,
    settings.embeddingBackendModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-direct-model",
    fetchedDirectEmbeddingModels,
    settings.embeddingModel || "",
  );
}

function _renderFetchedModelOptions(selectId, models, currentValue = "") {
  const select = document.getElementById(selectId);
  if (!select) return;

  const normalized = Array.isArray(models) ? models : [];
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = normalized.length
    ? "Chọn model từ kết quả tải về"
    : "Chưa lấy được model";
  select.appendChild(placeholder);

  normalized.forEach((model) => {
    const option = document.createElement("option");
    option.value = String(model?.id || "");
    option.textContent = String(model?.label || model?.id || "");
    select.appendChild(option);
  });

  if (
    currentValue &&
    normalized.some((model) => String(model?.id || "") === String(currentValue))
  ) {
    select.value = String(currentValue);
  } else {
    select.value = "";
  }

  select.style.display = normalized.length > 0 ? "" : "none";
}

function _refreshPromptCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-prompt-card").forEach((card) => {
    const settingKey = card.dataset.settingKey;
    const statusEl = card.querySelector(".bme-prompt-status");
    const resetButton = card.querySelector(".bme-prompt-reset");
    const isCustom = Boolean(String(settings?.[settingKey] || "").trim());
    card.classList.toggle("is-custom", isCustom);
    if (statusEl) {
      statusEl.textContent = isCustom ? "Đã tự định nghĩa" : "Mặc định";
      statusEl.classList.toggle("is-custom", isCustom);
    }
    if (resetButton) {
      resetButton.disabled = !isCustom;
    }
  });
}

function _toggleEmbedFields(mode) {
  const backendEl = document.getElementById("bme-embed-backend-fields");
  const directEl = document.getElementById("bme-embed-direct-fields");
  if (backendEl) backendEl.style.display = mode === "backend" ? "" : "none";
  if (directEl) directEl.style.display = mode === "direct" ? "" : "none";
}

function _setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el && el.value !== String(value ?? "")) {
    el.value = String(value ?? "");
  }
}

function _splitEmbeddingApiKeyPoolText(value) {
  return Array.from(
    new Set(
      String(value ?? "")
        .split(/\r?\n|[;,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function _normalizeEmbeddingApiKeyPoolText(value) {
  return _splitEmbeddingApiKeyPoolText(value).join("\n");
}

function _getPrimaryEmbeddingApiKeyFromPoolText(value) {
  return _splitEmbeddingApiKeyPoolText(value)[0] || "";
}

function _prepareEmbeddingApiKeyPoolUi() {
  const backendUrlInput = document.getElementById(
    "bme-setting-embed-backend-url",
  );
  if (backendUrlInput) {
    backendUrlInput.placeholder = "Chỉ Ollama / llama.cpp / vLLM mới cần điền";
  }

  const autoSuffixLabel = document.querySelector(
    'label[for="bme-setting-embed-auto-suffix"] span',
  );
  if (autoSuffixLabel) {
    autoSuffixLabel.textContent = "Tự động bổ sung hậu tố /embeddings";
  }

  const backendHelp = document.querySelector(
    "#bme-embed-backend-fields .bme-config-help",
  );
  if (backendHelp) {
    backendHelp.textContent =
      "Nếu trang hiện tại dùng HTTPS mà bạn lại điền HTTP, trình duyệt cục bộ có thể chặn mixed content; khi triển khai từ xa hãy ưu tiên dùng HTTPS hoặc lối vào cùng nguồn mà host có thể truy cập.";
  }

  const directFields = document.getElementById("bme-embed-direct-fields");
  const directHelp = directFields?.querySelector(".bme-config-help");
  if (directHelp) {
    directHelp.textContent =
      "Chế độ trực tiếp sẽ dùng bộ cấu hình riêng bên dưới.";
  }

  const embedUrlLabel = document.querySelector('label[for="bme-setting-embed-url"]');
  if (embedUrlLabel) {
    embedUrlLabel.textContent = "Địa chỉ API Embedding";
  }

  const embedModelLabel = document.querySelector(
    'label[for="bme-setting-embed-model"]',
  );
  if (embedModelLabel) {
    embedModelLabel.textContent = "Model Embedding";
  }

  const embedKeyLabel = document.querySelector('label[for="bme-setting-embed-key"]');
  if (embedKeyLabel) {
    embedKeyLabel.textContent = "Danh sách API Key Embedding";
  }

  let embedKeyInput = document.getElementById("bme-setting-embed-key");
  if (
    embedKeyInput &&
    String(embedKeyInput.tagName || "").toUpperCase() !== "TEXTAREA"
  ) {
    const textarea = document.createElement("textarea");
    textarea.id = embedKeyInput.id;
    textarea.className = "bme-config-textarea";
    textarea.rows = 4;
    textarea.value = embedKeyInput.value || "";
    textarea.placeholder = "sk-key-1\nsk-key-2\nsk-key-3";
    for (const attr of embedKeyInput.getAttributeNames()) {
      if (["id", "class", "type", "placeholder", "value"].includes(attr)) {
        continue;
      }
      textarea.setAttribute(attr, embedKeyInput.getAttribute(attr) || "");
    }
    embedKeyInput.replaceWith(textarea);
    embedKeyInput = textarea;
  }

  if (embedKeyInput) {
    embedKeyInput.className = "bme-config-textarea";
    embedKeyInput.placeholder = "sk-key-1\nsk-key-2\nsk-key-3";
    embedKeyInput.setAttribute("rows", "4");
  }

  let keyPoolHelp = directFields?.querySelector(".bme-embed-key-pool-help");
  if (!keyPoolHelp && embedKeyInput?.parentElement) {
    keyPoolHelp = document.createElement("div");
    keyPoolHelp.className = "bme-config-help bme-embed-key-pool-help";
    embedKeyInput.insertAdjacentElement("afterend", keyPoolHelp);
  }
  if (keyPoolHelp) {
    keyPoolHelp.textContent =
      "Mỗi dòng một key. BME sẽ xoay vòng theo pool; nếu key hiện tại bị rate limit hoặc hết quota, extension sẽ thử key kế tiếp. Cơ chế này chỉ áp dụng cho embedding trực tiếp.";
  }

  const fetchModelLabel = document.querySelector(
    "#bme-fetch-embed-direct-models span",
  );
  if (fetchModelLabel) {
    fetchModelLabel.textContent = "Lấy model";
  }

  const defaultModelOption = document.querySelector(
    '#bme-select-embed-direct-model option[value=""]',
  );
  if (defaultModelOption) {
    defaultModelOption.textContent = "Chọn model từ kết quả tải về";
  }
}

function _setCheckboxValue(id, checked) {
  const el = document.getElementById(id);
  if (el) {
    el.checked = Boolean(checked);
  }
}

function _parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function _escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function _escAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _safeCssToken(value, fallback = "unknown") {
  const token = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
}

function _matchesMemoryFilter(node, filter = "all") {
  if (!node || filter === "all") return true;
  const scope = normalizeMemoryScope(node.scope);
  switch (filter) {
    case "scope:objective":
      return scope.layer === "objective";
    case "scope:characterPov":
      return scope.layer === "pov" && scope.ownerType === "character";
    case "scope:userPov":
      return scope.layer === "pov" && scope.ownerType === "user";
    default:
      return node.type === filter;
  }
}

function _buildScopeMetaText(node) {
  const scope = normalizeMemoryScope(node?.scope);
  const parts = [];
  if (scope.layer === "pov") {
    parts.push(
      `${scope.ownerType === "user" ? "POV người dùng" : "POV nhân vật"}: ${scope.ownerName || scope.ownerId || "Chưa đặt tên"}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) parts.push(regionLine);
  const storyTime = _describeNodeStoryTimeDisplay(node);
  if (storyTime) parts.push(`cốt truyệnThời gian: ${storyTime}`);
  return parts.join(" · ");
}

/** Chỉ số như danh sách ký ức: tránh lỗi số thực in ra kiểu 9.499999999999998 */
function _formatMemoryMetricNumber(value, { fallback = 0, maxFrac = 2 } = {}) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "—";
  const rounded = Number.parseFloat(x.toFixed(maxFrac));
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function _formatMemoryInt(value, fallback = 0) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "—";
  return String(Math.trunc(x));
}

function _typeLabel(type) {
  const map = {
    character: "Nhân vật",
    event: "Sự kiện",
    location: "Địa điểm",
    thread: "tuyến chính",
    rule: "Quy tắc",
    synopsis: "Tóm lược toàn cục (cũ)",
    reflection: "Phản tư",
    pov_memory: "Ký ức chủ quan",
  };
  return map[type] || type || "—";
}

function _getNodeSnippet(node) {
  const fields = node.fields || {};
  const storyTime = _describeNodeStoryTimeDisplay(node);
  if (fields.summary) return fields.summary;
  if (fields.state) return fields.state;
  if (fields.constraint) return fields.constraint;
  if (fields.insight) return fields.insight;
  if (fields.traits) return fields.traits;
  if (storyTime) return `cốt truyệnThời gian: ${storyTime}`;

  const entries = Object.entries(fields).filter(
    ([key]) => !["name", "title", "summary", "embedding"].includes(key),
  );
  if (entries.length > 0) {
    return entries
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
  }
  return "Không có trường bổ sung";
}

function _isMobile() {
  return window.innerWidth <= 768;
}


