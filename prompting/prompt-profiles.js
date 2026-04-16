// ST-BME: tầng preset tác vụ và tương thích di chuyển cũ

import { DEFAULT_TASK_PROFILE_TEMPLATES } from "./default-task-profile-templates.js";

const TASK_TYPES = [
  "extract",
  "recall",
  "compress",
  "synopsis",
  "summary_rollup",
  "reflection",
  "consolidation",
];

const TASK_TYPE_META = {
  extract: {
    label: "Trích xuất",
    description: "Trích xuất ký ức có cấu trúc từ lô đối thoại hiện tại.",
  },
  recall: {
    label: "Truy hồi",
    description: "Sàng lọc các nút ký ức liên quan nhất dựa trên ngữ cảnh.",
  },
  compress: {
    label: "Nén",
    description: "Hợp nhất và nén nội dung nút cấp cao.",
  },
  synopsis: {
    label: "Tóm tắt ngắn",
    description: "Tạo tóm tắt ngắn theo giai đoạn dựa trên cửa sổ nguyên văn gần đây.",
  },
  summary_rollup: {
    label: "Gộp tóm tắt",
    description: "Gộp nhiều tóm tắt đang hoạt động thành bản tóm tắt cấp cao hơn.",
  },
  reflection: {
    label: "Phản tư",
    description: "Kết tủa các xu hướng dài hạn, điểm kích hoạt và đề xuất.",
  },
  consolidation: {
    label: "Hợp nhất",
    description: "Phân tích xung đột, khử trùng lặp và tiến hóa giữa ký ức cũ và mới.",
  },
};

const BUILTIN_BLOCK_DEFINITIONS = [
  {
    sourceKey: "taskName",
    name: "Tên tác vụ",
    role: "system",
    description: "Chèn dấu nhận biết loại tác vụ hiện tại (như extract, recall). Thường không cần thêm thủ công vì khối định nghĩa vai trò đã ngầm chứa danh tính tác vụ.",
  },
  {
    sourceKey: "systemInstruction",
    name: "Mô tả hệ thống",
    role: "system",
    description: "Chèn chỉ dẫn hệ thống cấp tác vụ. Có thể dùng để thêm ràng buộc chung hoặc quy tắc toàn cục. Gợi ý: có thể tạo nhiều khối tùy chỉnh và đặt vai trò khác nhau (system/user/assistant) để dàn prompt theo kiểu hội thoại nhiều lượt, dùng few-shot hướng LLM tuân thủ định dạng. Biến dùng được: {{charName}}, {{userName}}, {{charDescription}}, {{userPersona}}, {{currentTime}}.",
  },
  {
    sourceKey: "charDescription",
    name: "Mô tả nhân vật",
    role: "system",
    description: "Chèn phần mô tả chính của thẻ nhân vật hiện tại. Phù hợp với preset cần nhập trực tiếp thiết lập nhân vật vào prompt tác vụ.",
  },
  {
    sourceKey: "userPersona",
    name: "Thiết lập người dùng",
    role: "system",
    description: "Chèn Persona / thiết lập người dùng hiện tại. Phù hợp để tác vụ tham chiếu thiết lập dài hạn của người chơi khi sinh nội dung.",
  },
  {
    sourceKey: "worldInfoBefore",
    name: "Khối World Info phía trước",
    role: "system",
    description: "Chèn nội dung bucket before sau khi phân tích theo quy tắc World Info của SillyTavern, hỗ trợ World Info chính/phụ của nhân vật, World Info thiết lập người dùng, World Info cuộc chat và EJS / getwi trong các mục World Info.",
  },
  {
    sourceKey: "worldInfoAfter",
    name: "Khối World Info phía sau",
    role: "system",
    description: "Chèn nội dung bucket after sau khi phân tích theo quy tắc World Info của SillyTavern. Các mục atDepth sẽ không xuất hiện ở đây mà tự động đi vào chuỗi tin nhắn bổ sung.",
  },
  {
    sourceKey: "outputRules",
    name: "Quy tắc đầu ra",
    role: "system",
    description: "Chèn yêu cầu định dạng đầu ra JSON có cấu trúc. Phù hợp với các tác vụ cần đầu ra JSON nghiêm ngặt như extract, recall, consolidation.",
  },
  {
    sourceKey: "schema",
    name: "Schema",
    role: "system",
    description: "Chèn loại nút và định nghĩa trường của đồ thị tri thức. Tác vụ extract sẽ dùng để LLM biết có thể tạo những loại nút nào.",
  },
  {
    sourceKey: "recentMessages",
    name: "Tin nhắn gần nhất",
    role: "system",
    description: "Chèn các đoạn ngữ cảnh hội thoại gần nhất. Dùng cho tác vụ extract và recall để cung cấp lịch sử đối thoại cần thiết cho LLM phân tích.",
  },
  {
    sourceKey: "userMessage",
    name: "Tin nhắn người dùng",
    role: "system",
    description: "Chèn nội dung đầu vào mới nhất của người dùng hiện tại. Dùng cho tác vụ recall để khớp với các nút ký ức liên quan nhất.",
  },
  {
    sourceKey: "candidateText",
    name: "Văn bản ứng viên",
    role: "system",
    description: "Chèn văn bản tóm tắt ứng viên do chính tác vụ chuẩn bị. Phù hợp với các tác vụ như tóm tắt, nén hoặc gộp cần thêm chất liệu văn bản.",
  },
  {
    sourceKey: "candidateNodes",
    name: "Nút ứng viên",
    role: "system",
    description: "Chèn danh sách nút ký ức ứng viên cần sàng lọc. Dùng cho tác vụ recall (chọn nút liên quan) và consolidation (phát hiện xung đột).",
  },
  {
    sourceKey: "graphStats",
    name: "Thống kê đồ thị",
    role: "system",
    description: "Chèn bản tóm tắt trạng thái hiện tại của đồ thị (như số lượng nút, phân bố loại). Mọi loại tác vụ đều có thể dùng để giúp LLM nắm được toàn cảnh đồ thị.",
  },
  {
    sourceKey: "currentRange",
    name: "Phạm vi hiện tại",
    role: "system",
    description: "Chèn phạm vi tầng tin nhắn đang xử lý hiện tại (ví dụ: "Tầng 5 ~ Tầng 10"). Dùng cho tác vụ extract và compress.",
  },
  {
    sourceKey: "nodeContent",
    name: "Nội dung nút",
    role: "system",
    description: "Chèn nội dung chính văn của nút cần nén. Dành riêng cho tác vụ compress, bao gồm nhiều văn bản nút cần hợp nhất và tóm lược.",
  },
  {
    sourceKey: "eventSummary",
    name: "Tóm tắt sự kiện",
    role: "system",
    description: "Chèn bản tóm tắt dòng thời gian sự kiện gần đây. Dùng cho tác vụ synopsis (tạo phần tóm lược bối cảnh trước đó) và reflection (tạo phản tư).",
  },
  {
    sourceKey: "characterSummary",
    name: "Tóm tắt nhân vật",
    role: "system",
    description: "Chèn bản tóm tắt biến đổi trạng thái nhân vật gần đây. Dùng cho synopsis và reflection để giúp LLM nắm được động thái nhân vật.",
  },
  {
    sourceKey: "threadSummary",
    name: "Tóm tắt tuyến chính",
    role: "system",
    description: "Chèn bản tóm tắt tuyến truyện chính đang hoạt động. Dùng cho synopsis và reflection để giúp LLM nắm hướng đi của tự sự.",
  },
  {
    sourceKey: "contradictionSummary",
    name: "Tóm tắt mâu thuẫn",
    role: "system",
    description: "Chèn thông tin mâu thuẫn hoặc xung đột ký ức được phát hiện gần đây. Dành riêng cho reflection để kích hoạt phản tư sâu dựa trên mâu thuẫn.",
  },
  {
    sourceKey: "activeSummaries",
    name: "Tóm tắt hoạt động",
    role: "system",
    description: "Chèn snapshot tóm tắt phân tầng đang hoạt động hiện tại. Dùng cho extract để giúp LLM biết cục diện nào đã được tóm tắt gần đây và tránh trích xuất lặp lại nội dung đã bao phủ.",
  },
  {
    sourceKey: "storyTimeContext",
    name: "Thời gian cốt truyện",
    role: "system",
    description: "Chèn nhãn và nguồn của mốc thời gian cốt truyện đang hoạt động. Dùng cho extract để giúp LLM định vị lô hội thoại này trên trục thời gian cốt truyện.",
  },
];

const DEFAULT_TASK_PROFILE_VERSION = 3;
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_TASK_INPUT = Object.freeze({
  rawChatContextFloors: 0,
  rawChatSourceMode: "ignore_bme_hide",
});

const LEGACY_PROMPT_FIELD_MAP = {
  extract: "extractPrompt",
  recall: "recallPrompt",
  compress: "compressPrompt",
  synopsis: "synopsisPrompt",
  summary_rollup: "summaryRollupPrompt",
  reflection: "reflectionPrompt",
  consolidation: "consolidationPrompt",
};

// ═══════════════════════════════════════════════════
// Khối preset mặc định: tái sử dụng trực tiếp nội dung từ template mặc định,
// chỉ giữ một bộ fallback tiếng Việt tối thiểu để tránh nhân đôi prompt.
// ═══════════════════════════════════════════════════

const MINIMAL_FALLBACK_BLOCK_CONTENT = Object.freeze({
  heading:
    "# Đây là một thế giới hư cấu. Hãy nạp thiết lập bối cảnh hư cấu sau:",
  role:
    "Bạn là trợ lý xử lý bộ nhớ cho SillyTavern. Hãy thực hiện đúng loại tác vụ hiện tại, giữ nguyên định dạng đầu ra bắt buộc và không bịa thêm thông tin ngoài ngữ cảnh được cung cấp.",
  format: "Chỉ xuất một đối tượng JSON hợp lệ theo đúng schema đã yêu cầu.",
  rules:
    "Hãy ưu tiên tính chính xác, nhất quán thời gian, đúng phạm vi tác dụng và chỉ giữ lại thông tin thật sự hữu ích cho tác vụ hiện tại.",
});

function getTemplateBlockContent(taskType, blockId) {
  const template = DEFAULT_TASK_PROFILE_TEMPLATES?.[taskType];
  if (!template || !Array.isArray(template.blocks)) return "";
  const block = template.blocks.find((item) => String(item?.id || "") === blockId);
  return typeof block?.content === "string" ? block.content : "";
}

function createFallbackDefaultTaskBlockSet(taskType) {
  return {
    heading:
      getTemplateBlockContent(taskType, "default-heading") ||
      MINIMAL_FALLBACK_BLOCK_CONTENT.heading,
    role:
      getTemplateBlockContent(taskType, "default-role") ||
      MINIMAL_FALLBACK_BLOCK_CONTENT.role,
    format:
      getTemplateBlockContent(taskType, "default-format") ||
      MINIMAL_FALLBACK_BLOCK_CONTENT.format,
    rules:
      getTemplateBlockContent(taskType, "default-rules") ||
      MINIMAL_FALLBACK_BLOCK_CONTENT.rules,
  };
}

const FALLBACK_DEFAULT_TASK_BLOCKS = Object.freeze(
  Object.fromEntries(
    TASK_TYPES.map((taskType) => [taskType, createFallbackDefaultTaskBlockSet(taskType)]),
  ),
);

const COMMON_DEFAULT_BLOCK_BLUEPRINTS = [
  {
    id: "default-heading",
    name: "Phần mở đầu",
    type: "custom",
    role: "system",
    contentKey: "heading",
  },
  {
    id: "default-role",
    name: "Định danh nhân vật",
    type: "custom",
    role: "system",
    contentKey: "role",
  },
  {
    id: "default-char-desc",
    name: "Mô tả nhân vật",
    type: "builtin",
    role: "system",
    sourceKey: "charDescription",
  },
  {
    id: "default-user-persona",
    name: "Thiết lập người dùng",
    type: "builtin",
    role: "system",
    sourceKey: "userPersona",
  },
  {
    id: "default-wi-before",
    name: "Khối World Info phía trước",
    type: "builtin",
    role: "system",
    sourceKey: "worldInfoBefore",
  },
  {
    id: "default-wi-after",
    name: "Khối World Info phía sau",
    type: "builtin",
    role: "system",
    sourceKey: "worldInfoAfter",
  },
];

const TASK_CONTEXT_BLOCK_BLUEPRINTS = {
  extract: [
    {
      id: "default-recent-messages",
      name: "Tin nhắn gần nhất",
      type: "builtin",
      role: "system",
      sourceKey: "recentMessages",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
    {
      id: "default-schema",
      name: "Schema",
      type: "builtin",
      role: "system",
      sourceKey: "schema",
    },
    {
      id: "default-current-range",
      name: "Phạm vi hiện tại",
      type: "builtin",
      role: "system",
      sourceKey: "currentRange",
    },
    {
      id: "default-active-summaries",
      name: "Tóm tắt hoạt động",
      type: "builtin",
      role: "system",
      sourceKey: "activeSummaries",
    },
    {
      id: "default-story-time-context",
      name: "Thời gian cốt truyện",
      type: "builtin",
      role: "system",
      sourceKey: "storyTimeContext",
    },
  ],
  recall: [
    {
      id: "default-recent-messages",
      name: "Tin nhắn gần nhất",
      type: "builtin",
      role: "system",
      sourceKey: "recentMessages",
    },
    {
      id: "default-user-message",
      name: "Tin nhắn người dùng",
      type: "builtin",
      role: "system",
      sourceKey: "userMessage",
    },
    {
      id: "default-candidate-nodes",
      name: "Nút ứng viên",
      type: "builtin",
      role: "system",
      sourceKey: "candidateNodes",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  consolidation: [
    {
      id: "default-candidate-nodes",
      name: "Nút ứng viên",
      type: "builtin",
      role: "system",
      sourceKey: "candidateNodes",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  compress: [
    {
      id: "default-node-content",
      name: "Nội dung nút",
      type: "builtin",
      role: "system",
      sourceKey: "nodeContent",
    },
    {
      id: "default-current-range",
      name: "Phạm vi hiện tại",
      type: "builtin",
      role: "system",
      sourceKey: "currentRange",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  synopsis: [
    {
      id: "default-event-summary",
      name: "Tóm tắt sự kiện",
      type: "builtin",
      role: "system",
      sourceKey: "eventSummary",
    },
    {
      id: "default-character-summary",
      name: "Tóm tắt nhân vật",
      type: "builtin",
      role: "system",
      sourceKey: "characterSummary",
    },
    {
      id: "default-thread-summary",
      name: "Tóm tắt tuyến chính",
      type: "builtin",
      role: "system",
      sourceKey: "threadSummary",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
  reflection: [
    {
      id: "default-event-summary",
      name: "Tóm tắt sự kiện",
      type: "builtin",
      role: "system",
      sourceKey: "eventSummary",
    },
    {
      id: "default-character-summary",
      name: "Tóm tắt nhân vật",
      type: "builtin",
      role: "system",
      sourceKey: "characterSummary",
    },
    {
      id: "default-thread-summary",
      name: "Tóm tắt tuyến chính",
      type: "builtin",
      role: "system",
      sourceKey: "threadSummary",
    },
    {
      id: "default-contradiction-summary",
      name: "Tóm tắt mâu thuẫn",
      type: "builtin",
      role: "system",
      sourceKey: "contradictionSummary",
    },
    {
      id: "default-graph-stats",
      name: "Thống kê đồ thị",
      type: "builtin",
      role: "system",
      sourceKey: "graphStats",
    },
  ],
};

const DEFAULT_TRAILING_BLOCK_BLUEPRINTS = [
  {
    id: "default-format",
    name: "Định dạng đầu ra",
    type: "custom",
    role: "user",
    contentKey: "format",
  },
  {
    id: "default-rules",
    name: "Quy tắc hành vi",
    type: "custom",
    role: "user",
    contentKey: "rules",
  },
];

function applyRuntimeDefaultTemplateOverrides(taskType, template = null) {
  if (!template || typeof template !== "object") {
    return template;
  }

  const normalizedTaskType = String(taskType || "");
  if (!normalizedTaskType) {
    return template;
  }

  const overrideContent = FALLBACK_DEFAULT_TASK_BLOCKS[normalizedTaskType] || null;
  if (!overrideContent) {
    return template;
  }

  const blocks = Array.isArray(template.blocks) ? template.blocks : [];
  const replaceContent = (blockId, content = "") => {
    const block = blocks.find((item) => String(item?.id || "") === blockId);
    if (block) {
      block.content = String(content || "");
    }
  };

  replaceContent("default-heading", overrideContent.heading);
  replaceContent("default-role", overrideContent.role);
  replaceContent("default-format", overrideContent.format);
  replaceContent("default-rules", overrideContent.rules);

  template.version = Math.max(Number(template.version || 0), 4);
  template.updatedAt = "2026-04-10T23:20:00.000Z";
  return template;
}

function getDefaultTaskProfileTemplate(taskType) {
  const template = DEFAULT_TASK_PROFILE_TEMPLATES?.[taskType];
  if (!template || typeof template !== "object") {
    return null;
  }
  return applyRuntimeDefaultTemplateOverrides(taskType, cloneJson(template));
}

function hashTemplateFingerprint(value = "") {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getDefaultTaskProfileTemplateFingerprint(taskType) {
  const template = getDefaultTaskProfileTemplate(taskType);
  return hashTemplateFingerprint(JSON.stringify(template || null));
}

function getDefaultTaskProfileTemplateStamp(taskType) {
  const template = getDefaultTaskProfileTemplate(taskType);
  return {
    version: Number.isFinite(Number(template?.version))
      ? Number(template.version)
      : DEFAULT_TASK_PROFILE_VERSION,
    updatedAt:
      typeof template?.updatedAt === "string" && template.updatedAt
        ? template.updatedAt
        : "",
    fingerprint: getDefaultTaskProfileTemplateFingerprint(taskType),
  };
}

function buildDefaultTaskBlockTripletsFromTemplate(taskType) {
  const template = getDefaultTaskProfileTemplate(taskType);
  const blocks = Array.isArray(template?.blocks) ? template.blocks : [];
  const getContent = (blockId) =>
    String(
      blocks.find((block) => String(block?.id || "") === blockId)?.content || "",
    );
  return {
    heading: getContent("default-heading"),
    role: getContent("default-role"),
    format: getContent("default-format"),
    rules: getContent("default-rules"),
  };
}

const DEFAULT_TASK_BLOCKS = Object.fromEntries(
  TASK_TYPES.map((taskType) => [
    taskType,
    (() => {
      const fromTemplate = buildDefaultTaskBlockTripletsFromTemplate(taskType);
      if (
        fromTemplate.heading ||
        fromTemplate.role ||
        fromTemplate.format ||
        fromTemplate.rules
      ) {
        return fromTemplate;
      }
      return FALLBACK_DEFAULT_TASK_BLOCKS[taskType] || {
        heading: "",
        role: "",
        format: "",
        rules: "",
      };
    })(),
  ]),
);

export { DEFAULT_TASK_BLOCKS };

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function createUniqueId(prefix = "profile") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeRole(role) {
  const value = String(role || "system").trim().toLowerCase();
  if (["system", "user", "assistant"].includes(value)) {
    return value;
  }
  return "system";
}

function normalizeInjectionMode(mode) {
  const value = String(mode || "append").trim().toLowerCase();
  if (["append", "prepend", "relative"].includes(value)) {
    return value;
  }
  return "append";
}

function normalizePromptBlock(taskType, block = {}, index = 0) {
  const fallbackType = String(block?.type || "custom");
  return {
    id: String(block?.id || createPromptBlockId(taskType)),
    name: typeof block?.name === "string" ? block.name : "",
    type: fallbackType,
    enabled: block?.enabled !== false,
    role: normalizeRole(block?.role),
    sourceKey: typeof block?.sourceKey === "string" ? block.sourceKey : "",
    sourceField: typeof block?.sourceField === "string" ? block.sourceField : "",
    content: typeof block?.content === "string" ? block.content : "",
    injectionMode: normalizeInjectionMode(block?.injectionMode),
    order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
  };
}

function normalizeRegexLocalRule(rule = {}, taskType = "task", index = 0) {
  return {
    id: String(rule?.id || createRegexRuleId(taskType)),
    script_name: String(
      rule?.script_name || rule?.scriptName || `Cục bộQuy tắc ${index + 1}`,
    ),
    enabled: rule?.enabled !== false,
    find_regex: String(rule?.find_regex || rule?.findRegex || ""),
    replace_string: String(
      rule?.replace_string ?? rule?.replaceString ?? "",
    ),
    trim_strings: Array.isArray(rule?.trim_strings)
      ? rule.trim_strings.map((item) => String(item || ""))
      : typeof rule?.trim_strings === "string"
        ? rule.trim_strings
        : "",
    source: {
      user_input:
        rule?.source?.user_input === undefined
          ? true
          : Boolean(rule.source.user_input),
      ai_output:
        rule?.source?.ai_output === undefined
          ? true
          : Boolean(rule.source.ai_output),
    },
    destination: {
      prompt:
        rule?.destination?.prompt === undefined
          ? true
          : Boolean(rule.destination.prompt),
      display: Boolean(rule?.destination?.display),
    },
    min_depth: Number.isFinite(Number(rule?.min_depth))
      ? Number(rule.min_depth)
      : 0,
    max_depth: Number.isFinite(Number(rule?.max_depth))
      ? Number(rule.max_depth)
      : 9999,
  };
}

const TASK_REGEX_STAGE_ALIAS_MAP = Object.freeze({
  finalPrompt: "input.finalPrompt",
  rawResponse: "output.rawResponse",
  beforeParse: "output.beforeParse",
});

const TASK_REGEX_STAGE_GROUPS = Object.freeze({
  input: Object.freeze([
    "input.userMessage",
    "input.recentMessages",
    "input.candidateText",
    "input.finalPrompt",
  ]),
  output: Object.freeze([
    "output.rawResponse",
    "output.beforeParse",
  ]),
});

const DEFAULT_TASK_REGEX_STAGES = Object.freeze({
  "input.userMessage": true,
  "input.recentMessages": true,
  "input.candidateText": true,
  "input.finalPrompt": false,
  "output.rawResponse": false,
  "output.beforeParse": false,
  output: false,
});

 const DEFAULT_GLOBAL_TASK_REGEX_RULE_SPECS = Object.freeze([
   {
     id: "default-contamination-thinking-blocks",
     script_name: "Làm sạch mặc định: thinking/analysis/reasoning",
     enabled: true,
     find_regex: "/<(think|thinking|analysis|reasoning)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi",
     replace_string: "",
     trim_strings: "",
     source: {
       user_input: true,
       ai_output: true,
     },
     destination: {
       prompt: true,
       display: false,
     },
     min_depth: 0,
     max_depth: 9999,
   },
   {
     id: "default-contamination-choice-blocks",
     script_name: "Làm sạch mặc định: choice",
     enabled: true,
     find_regex: "/(?:<choice\\b[^>]*>[\\s\\S]*?<\\/choice>|<choice\\b[^>]*\\/?>)/gi",
     replace_string: "",
     trim_strings: "",
     source: {
       user_input: true,
       ai_output: true,
     },
     destination: {
       prompt: true,
       display: false,
     },
     min_depth: 0,
     max_depth: 9999,
   },
   {
     id: "default-contamination-updatevariable-tags",
     script_name: "Làm sạch mặc định: UpdateVariable",
     enabled: true,
     find_regex:
       "/(?:<updatevariable\\b[^>]*>[\\s\\S]*?<\\/updatevariable>|<updatevariable\\b[^>]*\\/?>)/gi",
     replace_string: "",
     trim_strings: "",
     source: {
       user_input: true,
       ai_output: true,
     },
     destination: {
       prompt: true,
       display: false,
     },
     min_depth: 0,
     max_depth: 9999,
   },
   {
     id: "default-contamination-status-current-variable-tags",
     script_name: "Làm sạch mặc định: status_current_variable",
     enabled: true,
     find_regex:
       "/(?:<status_current_variable\\b[^>]*>[\\s\\S]*?<\\/status_current_variable>|<status_current_variable\\b[^>]*\\/?>)/gi",
     replace_string: "",
     trim_strings: "",
     source: {
       user_input: true,
       ai_output: true,
     },
     destination: {
       prompt: true,
       display: false,
     },
     min_depth: 0,
     max_depth: 9999,
   },
   {
     id: "default-contamination-status-placeholder-tags",
     script_name: "Làm sạch mặc định: StatusPlaceHolderImpl",
     enabled: true,
     find_regex: "/<StatusPlaceHolderImpl\\b[^>]*\\/?>/gi",
     replace_string: "",
     trim_strings: "",
     source: {
       user_input: true,
       ai_output: true,
     },
     destination: {
       prompt: true,
       display: false,
     },
     min_depth: 0,
     max_depth: 9999,
   },
 ]);

 function cloneDefaultGlobalTaskRegexRules() {
   return DEFAULT_GLOBAL_TASK_REGEX_RULE_SPECS.map((rule, index) =>
     normalizeRegexLocalRule(
       {
         ...rule,
         source: {
           ...(rule.source || {}),
         },
         destination: {
           ...(rule.destination || {}),
         },
       },
       "global",
       index,
     ),
   );
 }

function normalizeRegexStageKey(stageKey = "") {
  const normalized = String(stageKey || "").trim();
  return TASK_REGEX_STAGE_ALIAS_MAP[normalized] || normalized;
}

export function normalizeTaskRegexStages(stages = {}) {
  const source =
    stages && typeof stages === "object" && !Array.isArray(stages) ? stages : {};
  const normalized = {};

  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(TASK_REGEX_STAGE_ALIAS_MAP, key)) {
      continue;
    }
    normalized[key] = Boolean(value);
  }

  for (const [legacyKey, canonicalKey] of Object.entries(
    TASK_REGEX_STAGE_ALIAS_MAP,
  )) {
    if (Object.prototype.hasOwnProperty.call(source, canonicalKey)) {
      // Respect an explicitly stored canonical key when both forms are
      // present. Legacy aliases should only backfill older exports.
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, legacyKey)) {
      normalized[canonicalKey] = Boolean(source[legacyKey]);
    }
  }

  return normalized;
}

export function createDefaultGlobalTaskRegex() {
  return {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: normalizeTaskRegexStages(DEFAULT_TASK_REGEX_STAGES),
    localRules: cloneDefaultGlobalTaskRegexRules(),
  };
}

export function dedupeRegexRules(rules = [], taskType = "task") {
  const sourceRules = Array.isArray(rules) ? rules : [];
  const deduped = [];
  const seen = new Set();

  for (let index = 0; index < sourceRules.length; index++) {
    const normalized = normalizeRegexLocalRule(sourceRules[index], taskType, index);
    const key = JSON.stringify({
      enabled: normalized.enabled !== false,
      find_regex: normalized.find_regex,
      replace_string: normalized.replace_string,
      trim_strings: normalized.trim_strings,
      source: {
        user_input: normalized.source?.user_input !== false,
        ai_output: normalized.source?.ai_output !== false,
      },
      destination: {
        prompt: normalized.destination?.prompt !== false,
        display: Boolean(normalized.destination?.display),
      },
      min_depth: normalized.min_depth,
      max_depth: normalized.max_depth,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

export function normalizeGlobalTaskRegex(config = {}, taskType = "global") {
  const defaults = createDefaultGlobalTaskRegex();
  const source =
    config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const normalizedTaskType = String(taskType || "").trim().toLowerCase();
  const defaultLocalRules = normalizedTaskType === "global" ? defaults.localRules : [];
  const rawLocalRules = Array.isArray(source.localRules)
    ? source.localRules
    : defaultLocalRules;

  return {
    enabled: source.enabled !== false,
    inheritStRegex: source.inheritStRegex !== false,
    sources: {
      ...defaults.sources,
      ...(source.sources && typeof source.sources === "object" ? source.sources : {}),
    },
    stages: {
      ...normalizeTaskRegexStages(defaults.stages),
      ...normalizeTaskRegexStages(source.stages || {}),
    },
    localRules: dedupeRegexRules(rawLocalRules, taskType),
  };
}

export function isTaskRegexStageEnabled(stages = {}, stageKey = "") {
  const normalizedStages = normalizeTaskRegexStages(stages);
  const normalizedStageKey = normalizeRegexStageKey(stageKey);

  if (!normalizedStageKey) {
    return normalizedStages.input !== false;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedStages, normalizedStageKey)) {
    return normalizedStages[normalizedStageKey] !== false;
  }

  if (normalizedStageKey.startsWith("input.")) {
    return normalizedStages.input !== false;
  }

  if (normalizedStageKey.startsWith("output.")) {
    return normalizedStages.output !== false;
  }

  return normalizedStages[normalizedStageKey] !== false;
}

function buildRegexConfigSignature(config = {}, taskType = "global") {
  const normalized = normalizeGlobalTaskRegex(config, taskType);
  return JSON.stringify({
    enabled: normalized.enabled !== false,
    inheritStRegex: normalized.inheritStRegex !== false,
    sources: {
      global: normalized.sources?.global !== false,
      preset: normalized.sources?.preset !== false,
      character: normalized.sources?.character !== false,
    },
    stages: normalizeTaskRegexStages(normalized.stages || {}),
  });
}

function getDefaultRegexConfigForTaskType(taskType = "global") {
  if (TASK_TYPES.includes(String(taskType || "").trim())) {
    return normalizeGlobalTaskRegex(
      createDefaultTaskProfile(taskType).regex || {},
      taskType,
    );
  }
  return normalizeGlobalTaskRegex(createDefaultGlobalTaskRegex(), "global");
}

export function describeLegacyTaskRegexConfig(taskType = "", regexConfig = {}) {
  const normalizedTaskType = String(taskType || "").trim();
  const effectiveTaskType = TASK_TYPES.includes(normalizedTaskType)
    ? normalizedTaskType
    : "global";
  const normalizedRegex = normalizeGlobalTaskRegex(
    regexConfig || {},
    effectiveTaskType,
  );
  const defaultRegex = getDefaultRegexConfigForTaskType(effectiveTaskType);
  const configSignature = buildRegexConfigSignature(
    normalizedRegex,
    effectiveTaskType,
  );
  const defaultConfigSignature = buildRegexConfigSignature(
    defaultRegex,
    effectiveTaskType,
  );
  const hasRules = normalizedRegex.localRules.length > 0;
  const hasConfigDiff = configSignature !== defaultConfigSignature;

  return {
    taskType: effectiveTaskType,
    regex: normalizedRegex,
    defaultRegex,
    configSignature,
    defaultConfigSignature,
    hasRules,
    hasConfigDiff,
    hasLegacyRegex: hasRules || hasConfigDiff,
  };
}

function normalizeTaskInputConfig(input = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rawChatSourceMode =
    String(source.rawChatSourceMode || DEFAULT_TASK_INPUT.rawChatSourceMode)
      .trim()
      .toLowerCase() === "ignore_bme_hide"
      ? "ignore_bme_hide"
      : DEFAULT_TASK_INPUT.rawChatSourceMode;
  return {
    rawChatContextFloors: Number.isFinite(Number(source.rawChatContextFloors))
      ? Math.max(0, Math.min(200, Math.trunc(Number(source.rawChatContextFloors))))
      : DEFAULT_TASK_INPUT.rawChatContextFloors,
    rawChatSourceMode,
  };
}

export function migrateLegacyProfileRegexToGlobal(
  globalTaskRegex = {},
  profile = null,
  { applyLegacyConfig = true } = {},
) {
  const currentGlobalRegex = normalizeGlobalTaskRegex(globalTaskRegex, "global");
  const profileTaskType = String(profile?.taskType || "").trim();
  const legacy = describeLegacyTaskRegexConfig(profileTaskType, profile?.regex || {});

  if (!legacy.hasLegacyRegex) {
    return {
      globalTaskRegex: currentGlobalRegex,
      mergedRuleCount: 0,
      profile,
      clearedLegacyRules: false,
      hasConfigDiff: false,
      appliedLegacyConfig: false,
      hasLegacyRegex: false,
    };
  }

  const mergedRules = dedupeRegexRules(
    [
      ...(Array.isArray(currentGlobalRegex.localRules)
        ? currentGlobalRegex.localRules
        : []),
      ...(Array.isArray(legacy.regex?.localRules) ? legacy.regex.localRules : []),
    ],
    "global",
  );

  const nextGlobalRegexBase =
    applyLegacyConfig && legacy.hasConfigDiff
      ? {
          ...currentGlobalRegex,
          enabled: legacy.regex.enabled !== false,
          inheritStRegex: legacy.regex.inheritStRegex !== false,
          sources: {
            ...(legacy.regex.sources || {}),
          },
          stages: {
            ...normalizeTaskRegexStages(legacy.regex.stages || {}),
          },
        }
      : currentGlobalRegex;

  return {
    globalTaskRegex: {
      ...nextGlobalRegexBase,
      localRules: mergedRules,
    },
    mergedRuleCount: Math.max(
      0,
      mergedRules.length -
        (Array.isArray(currentGlobalRegex.localRules)
          ? currentGlobalRegex.localRules.length
          : 0),
    ),
    profile: {
      ...(profile || {}),
      regex: {},
    },
    clearedLegacyRules: true,
    hasConfigDiff: legacy.hasConfigDiff,
    appliedLegacyConfig: Boolean(applyLegacyConfig && legacy.hasConfigDiff),
    hasLegacyRegex: true,
  };
}

function normalizeTaskProfilesState(taskProfiles = {}) {
  return ensureTaskProfiles({ taskProfiles });
}

function getDefaultProfileDescription(taskType) {
  return TASK_TYPE_META[taskType]?.description || "";
}

export function createPromptBlockId(taskType = "task") {
  return createUniqueId(`${taskType}-block`);
}

export function createRegexRuleId(taskType = "task") {
  return createUniqueId(`${taskType}-rule`);
}

export function createProfileId(taskType = "task") {
  return createUniqueId(`${taskType}-profile`);
}

export function createDefaultTaskProfiles() {
  const profiles = {};
  for (const taskType of TASK_TYPES) {
    profiles[taskType] = {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultTaskProfile(taskType)],
    };
  }
  return profiles;
}

function buildDefaultTaskProfileBlocks(taskType) {
  const template = getDefaultTaskProfileTemplate(taskType);
  if (Array.isArray(template?.blocks) && template.blocks.length > 0) {
    return template.blocks.map((block, index) => ({
      id: String(block?.id || createPromptBlockId(taskType)),
      name: typeof block?.name === "string" ? block.name : "",
      type: typeof block?.type === "string" ? block.type : "custom",
      enabled: block?.enabled !== false,
      role: normalizeRole(block?.role),
      sourceKey: typeof block?.sourceKey === "string" ? block.sourceKey : "",
      sourceField: typeof block?.sourceField === "string" ? block.sourceField : "",
      content: typeof block?.content === "string" ? block.content : "",
      injectionMode: normalizeInjectionMode(block?.injectionMode || "relative"),
      order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
    }));
  }

  const defaults = DEFAULT_TASK_BLOCKS[taskType] || {};
  const blueprints = [
    ...COMMON_DEFAULT_BLOCK_BLUEPRINTS,
    ...(TASK_CONTEXT_BLOCK_BLUEPRINTS[taskType] || []),
    ...DEFAULT_TRAILING_BLOCK_BLUEPRINTS,
  ];

  return blueprints.map((blueprint, index) => ({
    id: blueprint.id,
    name: blueprint.name,
    type: blueprint.type,
    enabled: true,
    role: blueprint.role,
    sourceKey: blueprint.sourceKey || "",
    sourceField: "",
    content:
      blueprint.type === "custom"
        ? typeof blueprint.content === "string"
          ? blueprint.content
          : String(defaults?.[blueprint.contentKey] || "")
        : "",
    injectionMode: "relative",
    order: index,
  }));
}

function mergeDefaultTaskProfileBlocks(taskType, existingBlocks = []) {
  const canonicalBlocks = buildDefaultTaskProfileBlocks(taskType);
  const existingById = new Map(
    (Array.isArray(existingBlocks) ? existingBlocks : [])
      .filter((block) => block && typeof block === "object")
      .map((block) => [String(block.id || ""), block]),
  );
  const merged = canonicalBlocks.map((canonicalBlock, index) => {
    const existing = existingById.get(canonicalBlock.id);
    if (!existing) {
      return {
        ...canonicalBlock,
        order: Number.isFinite(Number(canonicalBlock.order)) ? Number(canonicalBlock.order) : index,
      };
    }

    return {
      ...canonicalBlock,
      ...existing,
      id: canonicalBlock.id,
      name:
        typeof existing.name === "string" && existing.name
          ? existing.name
          : canonicalBlock.name,
      type: canonicalBlock.type,
      role: canonicalBlock.role,
      sourceKey: canonicalBlock.sourceKey || "",
      content:
        canonicalBlock.type === "custom"
          ? typeof existing.content === "string"
            ? existing.content
            : canonicalBlock.content
          : typeof existing.content === "string"
            ? existing.content
            : "",
      injectionMode:
        typeof existing.injectionMode === "string" && existing.injectionMode
          ? existing.injectionMode
          : canonicalBlock.injectionMode,
      order: Number.isFinite(Number(existing.order)) ? Number(existing.order) : index,
    };
  });

  const canonicalIds = new Set(canonicalBlocks.map((block) => block.id));
  const extraBlocks = (Array.isArray(existingBlocks) ? existingBlocks : [])
    .filter((block) => block && typeof block === "object")
    .filter((block) => !canonicalIds.has(String(block.id || "")))
    .map((block, index) => ({
      ...block,
      order: Number.isFinite(Number(block.order)) ? Number(block.order) : canonicalBlocks.length + index,
    }));

  return [...merged, ...extraBlocks];
}

function shouldRefreshBuiltinDefaultProfile(taskType, profile = {}) {
  if (String(profile?.id || "") !== DEFAULT_PROFILE_ID || profile?.builtin === false) {
    return false;
  }

  const expectedStamp = getDefaultTaskProfileTemplateStamp(taskType);
  const metadata = profile?.metadata || {};
  const currentVersion = Number.isFinite(Number(metadata?.defaultTemplateVersion))
    ? Number(metadata.defaultTemplateVersion)
    : Number.isFinite(Number(profile?.version))
      ? Number(profile.version)
      : 0;
  const currentUpdatedAt =
    typeof metadata?.defaultTemplateUpdatedAt === "string"
      ? metadata.defaultTemplateUpdatedAt
      : "";
  const currentFingerprint =
    typeof metadata?.defaultTemplateFingerprint === "string"
      ? metadata.defaultTemplateFingerprint
      : "";

  if (currentVersion < expectedStamp.version) {
    return true;
  }

  if (expectedStamp.fingerprint && currentFingerprint !== expectedStamp.fingerprint) {
    return true;
  }

  if (
    expectedStamp.updatedAt &&
    currentUpdatedAt &&
    currentUpdatedAt !== expectedStamp.updatedAt
  ) {
    return true;
  }

  if (expectedStamp.updatedAt && !currentUpdatedAt) {
    return true;
  }

  return false;
}

function createFallbackDefaultTaskProfile(taskType) {
  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  const templateStamp = getDefaultTaskProfileTemplateStamp(taskType);
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Preset mặc định",
    taskType,
    version: DEFAULT_TASK_PROFILE_VERSION,
    builtin: true,
    enabled: true,
    description: getDefaultProfileDescription(taskType),
    promptMode: "block-based",
    updatedAt: nowIso(),
    blocks: buildDefaultTaskProfileBlocks(taskType),
    generation: {
      llm_preset: "",
      max_context_tokens: null,
      max_completion_tokens: null,
      reply_count: null,
      stream: true,
      temperature: null,
      top_p: null,
      top_k: null,
      top_a: null,
      min_p: null,
      seed: null,
      frequency_penalty: null,
      presence_penalty: null,
      repetition_penalty: null,
      squash_system_messages: null,
      reasoning_effort: ["extract", "recall", "consolidation"].includes(taskType) ? "low" : null,
      request_thoughts: null,
      enable_function_calling: null,
      enable_web_search: null,
      character_name_prefix: null,
      wrap_user_messages_in_quotes: null,
    },
    input: normalizeTaskInputConfig(DEFAULT_TASK_INPUT),
    regex: {
      enabled: true,
      inheritStRegex: true,
      sources: {
        global: true,
        preset: true,
        character: true,
      },
      stages: normalizeTaskRegexStages(DEFAULT_TASK_REGEX_STAGES),
      localRules: [],
    },
    metadata: {
      migratedFromLegacy: false,
      legacyPromptField,
      defaultTemplateVersion: templateStamp.version,
      defaultTemplateUpdatedAt: templateStamp.updatedAt,
      defaultTemplateFingerprint: templateStamp.fingerprint,
    },
  };
}

export function createDefaultTaskProfile(taskType) {
  const template = getDefaultTaskProfileTemplate(taskType);
  if (!template) {
    return createFallbackDefaultTaskProfile(taskType);
  }

  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  const fallback = createFallbackDefaultTaskProfile(taskType);
  const templateStamp = getDefaultTaskProfileTemplateStamp(taskType);
  return {
    ...fallback,
    ...template,
    id: DEFAULT_PROFILE_ID,
    name: String(template?.name || fallback.name),
    taskType,
    version: DEFAULT_TASK_PROFILE_VERSION,
    builtin: true,
    enabled: template?.enabled !== false,
    description:
      typeof template?.description === "string"
        ? template.description
        : fallback.description,
    promptMode: String(template?.promptMode || fallback.promptMode),
    updatedAt:
      typeof template?.updatedAt === "string" && template.updatedAt
        ? template.updatedAt
        : nowIso(),
    blocks: buildDefaultTaskProfileBlocks(taskType),
    generation: {
      ...fallback.generation,
      ...(template?.generation || {}),
    },
    input: normalizeTaskInputConfig(template?.input || fallback.input),
    regex: {
      ...fallback.regex,
      ...(template?.regex || {}),
      sources: {
        ...fallback.regex.sources,
        ...(template?.regex?.sources || {}),
      },
      stages: {
        ...normalizeTaskRegexStages(fallback.regex.stages || {}),
        ...normalizeTaskRegexStages(template?.regex?.stages || {}),
      },
      localRules: Array.isArray(template?.regex?.localRules)
        ? template.regex.localRules.map((rule, index) =>
            normalizeRegexLocalRule(rule, taskType, index),
          )
        : [],
    },
    metadata: {
      ...fallback.metadata,
      ...(template?.metadata || {}),
      migratedFromLegacy: false,
      legacyPromptField,
      defaultTemplateVersion: templateStamp.version,
      defaultTemplateUpdatedAt: templateStamp.updatedAt,
      defaultTemplateFingerprint: templateStamp.fingerprint,
    },
  };
}

export function createCustomPromptBlock(taskType, overrides = {}) {
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: "Khối tùy chỉnh",
    type: "custom",
    enabled: true,
    role: "system",
    sourceKey: "",
    sourceField: "",
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createBuiltinPromptBlock(taskType, sourceKey = "", overrides = {}) {
  const definition =
    BUILTIN_BLOCK_DEFINITIONS.find((item) => item.sourceKey === sourceKey) ||
    BUILTIN_BLOCK_DEFINITIONS[0];
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: definition?.name || "Khối tích hợp",
    type: "builtin",
    enabled: true,
    role: definition?.role || "system",
    sourceKey: definition?.sourceKey || sourceKey,
    sourceField: "",
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createLegacyPromptBlock(taskType, overrides = {}) {
  const legacyField = LEGACY_PROMPT_FIELD_MAP[taskType] || "";
  return normalizePromptBlock(taskType, {
    id: createPromptBlockId(taskType),
    name: "Prompt mặc định",
    type: "legacyPrompt",
    enabled: true,
    role: "system",
    sourceKey: "",
    sourceField: legacyField,
    content: "",
    injectionMode: "append",
    order: 0,
    ...overrides,
  });
}

export function createLocalRegexRule(taskType, overrides = {}) {
  return normalizeRegexLocalRule(
    {
      id: createRegexRuleId(taskType),
      script_name: "Cục bộQuy tắc",
      enabled: true,
      find_regex: "",
      replace_string: "",
      trim_strings: "",
      source: {
        user_input: true,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
      min_depth: 0,
      max_depth: 9999,
      ...overrides,
    },
    taskType,
    0,
  );
}

export function ensureTaskProfiles(settings = {}) {
  const existing = settings.taskProfiles;
  const defaults = createDefaultTaskProfiles();

  if (!existing || typeof existing !== "object") {
    return defaults;
  }

  const normalized = {};
  for (const taskType of TASK_TYPES) {
    const current = existing[taskType] || {};
    const defaultBucket = defaults[taskType];
    let profiles =
      Array.isArray(current.profiles) && current.profiles.length > 0
        ? current.profiles.map((profile) =>
            normalizeTaskProfile(taskType, profile, settings),
          )
        : defaultBucket.profiles;

    const defaultIndex = profiles.findIndex(
      (profile) => String(profile?.id || "") === DEFAULT_PROFILE_ID,
    );
    if (defaultIndex >= 0 && shouldRefreshBuiltinDefaultProfile(taskType, profiles[defaultIndex])) {
      const refreshedDefault = createDefaultTaskProfile(taskType);
      profiles = [
        ...profiles.slice(0, defaultIndex),
        refreshedDefault,
        ...profiles.slice(defaultIndex + 1),
      ];
    }

    const activeProfileId =
      typeof current.activeProfileId === "string" &&
      profiles.some((profile) => profile.id === current.activeProfileId)
        ? current.activeProfileId
        : profiles[0]?.id || DEFAULT_PROFILE_ID;

    normalized[taskType] = {
      activeProfileId,
      profiles,
    };
  }

  return normalized;
}

export function normalizeTaskProfile(taskType, profile = {}, settings = {}) {
  const base = createDefaultTaskProfile(taskType);
  const legacyPromptField = LEGACY_PROMPT_FIELD_MAP[taskType];
  const isBuiltinDefaultProfile =
    String(profile?.id || base.id) === DEFAULT_PROFILE_ID &&
    profile?.builtin !== false;
  const rawBlocks =
    Array.isArray(profile.blocks) && profile.blocks.length > 0
      ? isBuiltinDefaultProfile
        ? mergeDefaultTaskProfileBlocks(taskType, profile.blocks)
        : profile.blocks
      : base.blocks;
  const blocks = rawBlocks.map((block, index) =>
    normalizePromptBlock(taskType, block, index),
  );

  return {
    ...base,
    ...profile,
    id: String(profile?.id || base.id),
    name: String(profile?.name || base.name),
    taskType,
    builtin:
      profile?.builtin === undefined
        ? profile?.id === DEFAULT_PROFILE_ID
        : Boolean(profile?.builtin),
    enabled: profile?.enabled !== false,
    description:
      typeof profile?.description === "string"
        ? profile.description
        : base.description,
    promptMode: String(profile?.promptMode || base.promptMode),
    updatedAt:
      typeof profile?.updatedAt === "string" && profile.updatedAt
        ? profile.updatedAt
        : nowIso(),
    blocks,
    generation: {
      ...base.generation,
      ...(profile?.generation || {}),
    },
    input: normalizeTaskInputConfig({
      ...base.input,
      ...(profile?.input || {}),
    }),
    regex: {
      ...base.regex,
      ...(profile?.regex || {}),
      sources: {
        ...base.regex.sources,
        ...(profile?.regex?.sources || {}),
      },
      stages: {
        ...normalizeTaskRegexStages(base.regex.stages || {}),
        ...normalizeTaskRegexStages(profile?.regex?.stages || {}),
      },
      localRules: Array.isArray(profile?.regex?.localRules)
        ? profile.regex.localRules.map((rule, index) =>
            normalizeRegexLocalRule(rule, taskType, index),
          )
        : [],
    },
    metadata: {
      ...base.metadata,
      ...(profile?.metadata || {}),
      legacyPromptField,
      legacyPromptSnapshot:
        typeof settings?.[legacyPromptField] === "string"
          ? settings[legacyPromptField]
          : "",
    },
  };
}

export function migrateLegacyTaskProfiles(settings = {}) {
  const alreadyMigrated =
    Number(settings.taskProfilesVersion) >= DEFAULT_TASK_PROFILE_VERSION;
  const nextTaskProfiles = ensureTaskProfiles(settings);
  let changed = !alreadyMigrated;

  for (const taskType of TASK_TYPES) {
    const legacyField = LEGACY_PROMPT_FIELD_MAP[taskType];
    const legacyPrompt =
      typeof settings?.[legacyField] === "string" ? settings[legacyField] : "";
    const bucket = nextTaskProfiles[taskType];
    if (!bucket || !Array.isArray(bucket.profiles) || bucket.profiles.length === 0) {
      nextTaskProfiles[taskType] = {
        activeProfileId: DEFAULT_PROFILE_ID,
        profiles: [createDefaultTaskProfile(taskType)],
      };
      changed = true;
      continue;
    }

    const firstProfile = bucket.profiles[0];
    if (
      firstProfile?.id === DEFAULT_PROFILE_ID &&
      firstProfile?.metadata?.migratedFromLegacy !== true &&
      legacyPrompt
    ) {
      firstProfile.metadata = {
        ...(firstProfile.metadata || {}),
        migratedFromLegacy: true,
        legacyPromptField: legacyField,
        legacyPromptSnapshot: legacyPrompt,
      };
      changed = true;
    }
  }

  return {
    changed,
    taskProfilesVersion: DEFAULT_TASK_PROFILE_VERSION,
    taskProfiles: nextTaskProfiles,
  };
}

export function migratePerTaskRegexToGlobal(settings = {}) {
  const taskProfiles = ensureTaskProfiles(settings);
  const defaultGlobalRegex = normalizeGlobalTaskRegex(
    createDefaultGlobalTaskRegex(),
    "global",
  );
  const existingGlobalRegex = normalizeGlobalTaskRegex(
    settings.globalTaskRegex || {},
    "global",
  );
  const existingGlobalConfigSignature = buildRegexConfigSignature(
    existingGlobalRegex,
    "global",
  );
  const hasExistingGlobalRules = existingGlobalRegex.localRules.length > 0;
  const defaultGlobalConfigSignature = buildRegexConfigSignature(
    defaultGlobalRegex,
    "global",
  );
  const profilesWithLegacyRegex = [];

  for (const taskType of TASK_TYPES) {
    const bucket = taskProfiles[taskType];

    for (const profile of Array.isArray(bucket?.profiles) ? bucket.profiles : []) {
      const legacy = describeLegacyTaskRegexConfig(taskType, profile?.regex || {});
      if (!legacy.hasLegacyRegex) continue;
      profilesWithLegacyRegex.push({
        taskType,
        profileId: String(profile?.id || ""),
        regex: legacy.regex,
        configSignature: legacy.configSignature,
        hasConfigDiff: legacy.hasConfigDiff,
      });
    }
  }

  if (profilesWithLegacyRegex.length === 0) {
    return {
      changed: false,
      settings: {
        ...settings,
        taskProfiles,
      },
    };
  }

  const configCandidates = profilesWithLegacyRegex.filter(
    (item) => item.hasConfigDiff,
  );
  const uniqueCandidateSignatures = [
    ...new Set(configCandidates.map((item) => item.configSignature)),
  ];
  if (uniqueCandidateSignatures.length > 1) {
    console.warn(
      "[ST-BME] Phát hiện nhiều preset tác vụ có cấu hình regex cũ xung đột; hệ thống đã lấy bản đầu tiên theo thứ tự và di chuyển thống nhất.",
      configCandidates.map((item) => ({
        taskType: item.taskType,
        profileId: item.profileId,
      })),
    );
  }

  const selectedConfig =
    existingGlobalConfigSignature !== defaultGlobalConfigSignature
      ? existingGlobalRegex
      : configCandidates[0]?.regex || defaultGlobalRegex;

  const mergedLocalRules = dedupeRegexRules(
    [
      ...(Array.isArray(existingGlobalRegex.localRules)
        ? existingGlobalRegex.localRules
        : []),
      ...profilesWithLegacyRegex.flatMap((item) =>
        Array.isArray(item.regex?.localRules) ? item.regex.localRules : [],
      ),
    ],
    "global",
  );

  const normalizedSelectedConfig = normalizeGlobalTaskRegex(selectedConfig, "global");
  const nextGlobalRegex = {
    ...normalizedSelectedConfig,
    enabled:
      existingGlobalConfigSignature !== defaultGlobalConfigSignature ||
      hasExistingGlobalRules
        ? normalizedSelectedConfig.enabled !== false
        : false,
    localRules: mergedLocalRules,
  };

  const nextTaskProfiles = {};
  for (const taskType of TASK_TYPES) {
    const bucket = taskProfiles[taskType] || {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultTaskProfile(taskType)],
    };
    const legacyProfileIds = new Set(
      profilesWithLegacyRegex
        .filter((item) => item.taskType === taskType)
        .map((item) => item.profileId),
    );
    nextTaskProfiles[taskType] = {
      ...bucket,
      profiles: (Array.isArray(bucket.profiles) ? bucket.profiles : []).map((profile) =>
        legacyProfileIds.has(String(profile?.id || ""))
          ? normalizeTaskProfile(taskType, {
              ...profile,
              regex: {},
            })
          : normalizeTaskProfile(taskType, profile),
      ),
    };
  }

  return {
    changed: true,
    settings: {
      ...settings,
      globalTaskRegex: nextGlobalRegex,
      taskProfiles: nextTaskProfiles,
    },
  };
}

export function getActiveTaskProfile(settings = {}, taskType) {
  const taskProfiles = ensureTaskProfiles(settings);
  const bucket = taskProfiles?.[taskType];
  if (!bucket?.profiles?.length) {
    return createDefaultTaskProfile(taskType);
  }
  return (
    bucket.profiles.find((profile) => profile.id === bucket.activeProfileId) ||
    bucket.profiles[0]
  );
}

export function getLegacyPromptForTask(settings = {}, taskType) {
  const field = LEGACY_PROMPT_FIELD_MAP[taskType];
  return typeof settings?.[field] === "string" ? settings[field] : "";
}

export function getLegacyPromptFieldForTask(taskType) {
  return LEGACY_PROMPT_FIELD_MAP[taskType] || "";
}

export function getTaskTypeMeta(taskType) {
  return {
    id: taskType,
    label: TASK_TYPE_META[taskType]?.label || taskType,
    description: TASK_TYPE_META[taskType]?.description || "",
  };
}

export function getTaskTypeOptions() {
  return TASK_TYPES.map((taskType) => getTaskTypeMeta(taskType));
}

export function getTaskTypes() {
  return [...TASK_TYPES];
}

export function getBuiltinBlockDefinitions() {
  return BUILTIN_BLOCK_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function cloneTaskProfile(profile = {}, options = {}) {
  const taskType = String(options.taskType || profile.taskType || "extract");
  const cloned = normalizeTaskProfile(taskType, cloneJson(profile));
  const nextName = String(options.name || "").trim() || `${cloned.name} bản sao`;
  const nextProfile = {
    ...cloned,
    id: createProfileId(taskType),
    taskType,
    name: nextName,
    builtin: false,
    updatedAt: nowIso(),
    blocks: (Array.isArray(cloned.blocks) ? cloned.blocks : []).map(
      (block, index) =>
        normalizePromptBlock(
          taskType,
          {
            ...block,
            id: createPromptBlockId(taskType),
            order: index,
          },
          index,
        ),
    ),
    regex: {
      ...(cloned.regex || {}),
      localRules: Array.isArray(cloned?.regex?.localRules)
        ? cloned.regex.localRules.map((rule, index) =>
            normalizeRegexLocalRule(
              {
                ...rule,
                id: createRegexRuleId(taskType),
              },
              taskType,
              index,
            ),
          )
        : [],
    },
    metadata: {
      ...(cloned.metadata || {}),
      clonedFromId: cloned.id || "",
      clonedAt: nowIso(),
    },
  };

  return nextProfile;
}

export function upsertTaskProfile(
  taskProfiles = {},
  taskType,
  profile,
  options = {},
) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType] || {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [],
  };
  const normalizedProfile = normalizeTaskProfile(taskType, {
    ...(profile || {}),
    updatedAt: nowIso(),
  });
  const nextProfiles = [...bucket.profiles];
  const existingIndex = nextProfiles.findIndex(
    (item) => item.id === normalizedProfile.id,
  );

  if (existingIndex >= 0) {
    nextProfiles.splice(existingIndex, 1, normalizedProfile);
  } else if (normalizedProfile.id === DEFAULT_PROFILE_ID) {
    nextProfiles.unshift(normalizedProfile);
  } else {
    nextProfiles.push(normalizedProfile);
  }

  normalizedState[taskType] = {
    activeProfileId:
      options.setActive === false
        ? bucket.activeProfileId
        : normalizedProfile.id,
    profiles: nextProfiles.map((item, index) =>
      normalizeTaskProfile(taskType, {
        ...item,
        blocks: Array.isArray(item.blocks)
          ? item.blocks.map((block, blockIndex) => ({
              ...block,
              order: Number.isFinite(Number(block?.order))
                ? Number(block.order)
                : blockIndex,
            }))
          : [],
        builtin: item.id === DEFAULT_PROFILE_ID ? true : item.builtin,
        updatedAt:
          item.id === normalizedProfile.id ? normalizedProfile.updatedAt : item.updatedAt,
      }),
    ),
  };

  return normalizedState;
}

export function setActiveTaskProfileId(taskProfiles = {}, taskType, profileId) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  if (!bucket?.profiles?.some((profile) => profile.id === profileId)) {
    return normalizedState;
  }
  normalizedState[taskType] = {
    ...bucket,
    activeProfileId: profileId,
  };
  return normalizedState;
}

export function deleteTaskProfile(taskProfiles = {}, taskType, profileId) {
  if (!profileId) return normalizeTaskProfilesState(taskProfiles);

  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  if (!bucket?.profiles?.length) {
    return normalizedState;
  }

  const remaining = bucket.profiles.filter((profile) => profile.id !== profileId);
  if (remaining.length === 0) {
    normalizedState[taskType] = {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultTaskProfile(taskType)],
    };
    return normalizedState;
  }

  normalizedState[taskType] = {
    activeProfileId: remaining.some(
      (profile) => profile.id === bucket.activeProfileId,
    )
      ? bucket.activeProfileId
      : remaining[0].id,
    profiles: remaining,
  };
  return normalizedState;
}

export function restoreDefaultTaskProfile(taskProfiles = {}, taskType) {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType] || {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [],
  };
  const defaultProfile = createDefaultTaskProfile(taskType);
  const remaining = (bucket.profiles || []).filter(
    (profile) => profile.id !== DEFAULT_PROFILE_ID,
  );

  normalizedState[taskType] = {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [defaultProfile, ...remaining],
  };

  return normalizedState;
}

export function exportTaskProfile(taskProfiles = {}, taskType, profileId = "") {
  const normalizedState = normalizeTaskProfilesState(taskProfiles);
  const bucket = normalizedState[taskType];
  const profile =
    bucket?.profiles?.find((item) => item.id === profileId) ||
    bucket?.profiles?.[0];

  if (!profile) {
    throw new Error(`Task profile not found: ${taskType}/${profileId}`);
  }

  return {
    format: "st-bme-task-profile",
    version: DEFAULT_TASK_PROFILE_VERSION,
    taskType,
    exportedAt: nowIso(),
    profile: cloneJson(profile),
  };
}

export function importTaskProfile(
  taskProfiles = {},
  rawInput,
  preferredTaskType = "",
) {
  const parsed =
    typeof rawInput === "string" ? JSON.parse(rawInput) : cloneJson(rawInput);
  const candidate =
    parsed?.profile && typeof parsed.profile === "object"
      ? parsed.profile
      : parsed;
  const importedTaskType = String(
    preferredTaskType || parsed?.taskType || candidate?.taskType || "",
  ).trim();

  if (!TASK_TYPES.includes(importedTaskType)) {
    throw new Error(`Unsupported task type: ${importedTaskType || "(empty)"}`);
  }

  const bucket = normalizeTaskProfilesState(taskProfiles)[importedTaskType];
  const baseName = String(candidate?.name || "").trim() || "Nhập preset";
  const importedProfile = normalizeTaskProfile(importedTaskType, {
    ...candidate,
    id: createProfileId(importedTaskType),
    taskType: importedTaskType,
    name: baseName,
    builtin: false,
    updatedAt: nowIso(),
    metadata: {
      ...(candidate?.metadata || {}),
      importedAt: nowIso(),
    },
    blocks: Array.isArray(candidate?.blocks) && candidate.blocks.length > 0
      ? candidate.blocks.map((block, index) => ({
          ...block,
          id: createPromptBlockId(importedTaskType),
          order: index,
        }))
      : createDefaultTaskProfile(importedTaskType).blocks,
    regex: {
      ...(candidate?.regex || {}),
      localRules: Array.isArray(candidate?.regex?.localRules)
        ? candidate.regex.localRules.map((rule) => ({
            ...rule,
            id: createRegexRuleId(importedTaskType),
          }))
        : [],
    },
  });

  const nextTaskProfiles = upsertTaskProfile(
    {
      ...normalizeTaskProfilesState(taskProfiles),
      [importedTaskType]: bucket,
    },
    importedTaskType,
    importedProfile,
    { setActive: true },
  );

  return {
    taskProfiles: nextTaskProfiles,
    taskType: importedTaskType,
    profile: importedProfile,
  };
}
