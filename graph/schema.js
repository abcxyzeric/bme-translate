// ST-BME: nútLoại Schema định nghĩa
// định nghĩađồ thị中支持的nútLoại、字段、Tiêm策略和NénCấu hình

/**
 * Nén模式
 */
export const COMPRESSION_MODE = {
  NONE: "none",
  HIERARCHICAL: "hierarchical",
};

/**
 * Mặc địnhnútLoại Schema
 * 每种Loạiđịnh nghĩa了：
 * - id: 唯一标识
 * - label: 显示Tên
 * - tableName: Tiêm时的表名
 * - columns: 字段列表 [{name, hint, required}]
 * - alwaysInject: 是否常驻Tiêm（true=Core, false=需要Truy hồi）
 * - latestOnly: 是否只保留最新版本（用于Nhân vật/Địa điểm等随时间Cập nhật的实体）
 * - forceUpdate: 每lầnTrích xuất是否必须产出此Loạinút
 * - compression: NénCấu hình
 */
export const DEFAULT_NODE_SCHEMA = [
  {
    id: "event",
    label: "Sự kiện",
    tableName: "event_table",
    columns: [
      { name: "title", hint: "Tên sự kiện ngắn（建议 6-10 字，用于đồ thị显示）", required: false },
      { name: "summary", hint: "Sự kiệntóm tắt，包含因果关系和Kết quả", required: true },
      { name: "participants", hint: "参与Tên nhân vật，逗号分隔", required: false },
      {
        name: "status",
        hint: "Sự kiệnTrạng thái：ongoing/resolved/blocked",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: true,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 9,
      fanIn: 3,
      maxDepth: 10,
      keepRecentLeaves: 6,
      instruction:
        "将Sự kiệnnútNén为高价值的剧情里程碑tóm tắt。保留因果关系、不可逆Kết quả和未解决的伏笔。",
    },
  },
  {
    id: "character",
    label: "Nhân vật",
    tableName: "character_table",
    columns: [
      { name: "name", hint: "Tên nhân vật（仅规范Tên）", required: true },
      { name: "traits", hint: "稳定的性格特征和外貌标记", required: false },
      { name: "state", hint: "Trạng thái hiện tại或处境", required: false },
      { name: "goal", hint: "当前目标或动机", required: false },
      { name: "inventory", hint: "携带或拥有的关键物品", required: false },
      { name: "core_note", hint: "值得长期记住的关键备注", required: false },
    ],
    alwaysInject: false,
    latestOnly: true,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "location",
    label: "Địa điểm",
    tableName: "location_table",
    columns: [
      { name: "name", hint: "Địa điểmTên（仅规范Tên）", required: true },
      { name: "state", hint: "Trạng thái hiện tại或环境条件", required: false },
      { name: "features", hint: "重要特征、资源或服务", required: false },
      { name: "danger", hint: "危险等级或威胁", required: false },
    ],
    alwaysInject: false,
    latestOnly: true,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "rule",
    label: "Quy tắc",
    tableName: "rule_table",
    columns: [
      { name: "title", hint: "简短Quy tắc名", required: true },
      { name: "constraint", hint: "不可违反的Quy tắcNội dung", required: true },
      { name: "scope", hint: "适用Phạm vi/场景", required: false },
      {
        name: "status",
        hint: "当前有效性：active/suspended/revoked",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "thread",
    label: "tuyến chính",
    tableName: "thread_table",
    columns: [
      { name: "title", hint: "tuyến chínhTên", required: true },
      { name: "summary", hint: "当前进展tóm tắt", required: false },
      {
        name: "status",
        hint: "Trạng thái：active/completed/abandoned",
        required: false,
      },
    ],
    alwaysInject: true,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 6,
      fanIn: 3,
      maxDepth: 5,
      keepRecentLeaves: 3,
      instruction: "将tuyến chínhnútNén为阶段性进展tóm tắt。保留关键转折和当前目标。",
    },
  },
  // ====== v2 新增nútLoại ======
  {
    id: "synopsis",
    label: "Toàn cục概要（旧）",
    tableName: "synopsis_table",
    columns: [
      {
        name: "summary",
        hint: "旧式单条Toàn cục前情提要（兼容 / 迁移兜底）",
        required: true,
      },
      { name: "scope", hint: "该旧式概要覆盖的tầngPhạm vi", required: false },
    ],
    alwaysInject: true, // 常驻Tiêm（MemoRAG 启发）
    latestOnly: true, // 只保留最新版本
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.NONE,
      threshold: 0,
      fanIn: 0,
      maxDepth: 0,
      keepRecentLeaves: 0,
      instruction: "",
    },
  },
  {
    id: "reflection",
    label: "Phản tư",
    tableName: "reflection_table",
    columns: [
      { name: "insight", hint: "对Nhân vậtHành vi或情节的元认知Phản tư", required: true },
      { name: "trigger", hint: "触发Phản tư的Sự kiện/矛盾", required: false },
      { name: "suggestion", hint: "对后续叙事的建议", required: false },
    ],
    alwaysInject: false, // 需要被Truy hồi
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 6,
      fanIn: 3,
      maxDepth: 3,
      keepRecentLeaves: 3,
      instruction: "将Phản tư条目合并为高层lần的叙事指导原则。",
    },
  },
  {
    id: "pov_memory",
    label: "Ký ức chủ quan",
    tableName: "pov_memory_table",
    columns: [
      { name: "summary", hint: "这个视角如何记住这件事", required: true },
      { name: "belief", hint: "她/他认为发生了什么", required: false },
      { name: "emotion", hint: "主观Cảm xúc反应", required: false },
      { name: "attitude", hint: "对人物或Sự kiện的Thái độ", required: false },
      {
        name: "certainty",
        hint: "确定度：certain/unsure/mistaken",
        required: false,
      },
      { name: "about", hint: "Liên kếtđối tượng或引用标签", required: false },
    ],
    alwaysInject: false,
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 8,
      fanIn: 3,
      maxDepth: 4,
      keepRecentLeaves: 4,
      instruction:
        "将同一视角、同一Nhân vật归属下的Ký ức chủ quanNén成更稳定的第一视角Ký ứctóm tắt，保留误解、Cảm xúc和Thái độ变化。",
    },
  },
];

/**
 * 规范化的关系Loại
 */
export const RELATION_TYPES = [
  "related", // 一般Liên kết
  "involved_in", // 参与Sự kiện
  "occurred_at", // 发生于Địa điểm
  "advances", // 推进tuyến chính
  "updates", // Cập nhật实体Trạng thái
  "contradicts", // 矛盾/冲突（用于抑制边）
  "evolves", // A-MEM 进化链接（新→旧）
  "temporal_update", // 时序Cập nhật（Graphiti：新Trạng thái替代旧Trạng thái）
];

/**
 * 验证 Schema Cấu hình的合法性
 * @param {Array} schema
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSchema(schema) {
  const errors = [];

  if (!Array.isArray(schema) || schema.length === 0) {
    errors.push("Schema 必须是非空数组");
    return { valid: false, errors };
  }

  const ids = new Set();
  const tableNames = new Set();

  for (const type of schema) {
    if (!type || typeof type !== "object") {
      errors.push("Schema Loạiđịnh nghĩa必须是đối tượng");
      continue;
    }

    if (!type.id || typeof type.id !== "string") {
      errors.push("每种Loại必须有 id");
      continue;
    }

    if (ids.has(type.id)) {
      errors.push(`Loại ID 重复：${type.id}`);
    }
    ids.add(type.id);

    if (!type.label || typeof type.label !== "string") {
      errors.push(`Loại ${type.id}：缺少 label`);
    }

    if (!type.tableName || typeof type.tableName !== "string") {
      errors.push(`Loại ${type.id}：缺少 tableName`);
    } else if (tableNames.has(type.tableName)) {
      errors.push(`表名重复：${type.tableName}`);
    } else {
      tableNames.add(type.tableName);
    }

    if (!Array.isArray(type.columns) || type.columns.length === 0) {
      errors.push(`Loại ${type.id}：至少需要一个列`);
      continue;
    }

    const columnNames = new Set();
    for (const column of type.columns) {
      if (!column?.name || typeof column.name !== "string") {
        errors.push(`Loại ${type.id}：存在缺少 name 的列định nghĩa`);
        continue;
      }
      if (columnNames.has(column.name)) {
        errors.push(`Loại ${type.id}：列名重复 ${column.name}`);
      }
      columnNames.add(column.name);
    }

    const hasRequired = type.columns.some((c) => c?.required);
    if (!hasRequired) {
      errors.push(`Loại ${type.id}：至少需要一个 required 列`);
    }

    if (type.latestOnly) {
      const hasPrimaryLikeField = ["name", "title", "summary"].some(
        (fieldName) =>
          type.columns.some((column) => column?.name === fieldName),
      );
      if (!hasPrimaryLikeField) {
        errors.push(
          `Loại ${type.id}：latestOnly Loại至少需要 name/title/summary 之一作为主标识字段`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 获取 Schema 中某个Loại的định nghĩa
 * @param {Array} schema
 * @param {string} typeId
 * @returns {object|null}
 */
export function getSchemaType(schema, typeId) {
  return schema.find((t) => t.id === typeId) || null;
}
