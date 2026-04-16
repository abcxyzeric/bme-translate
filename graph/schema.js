// ST-BME: nútLoại Schema định nghĩa
// Định nghĩa các loại nút, trường, chiến lược tiêm và cấu hình nén được hỗ trợ trong đồ thị

/**
 * Nénchế độ
 */
export const COMPRESSION_MODE = {
  NONE: "none",
  HIERARCHICAL: "hierarchical",
};

/**
 * Mặc địnhnútLoại Schema
 * Mỗi loại định nghĩa các mục sau:
 * - id: mã nhận diện duy nhất
 * - label: hiển thịTên
 * - tableName: tên bảng khi tiêm
 * - columns: danh sách trường [{name, hint, required}]
 * - alwaysInject: liệu cóthường trúTiêm（true=Core, false=cầnTruy hồi）
 * - latestOnly: có chỉ giữ lại phiên bản mới nhất hay không (dùng cho các thực thể như nhân vật/địa điểm được cập nhật theo thời gian)
 * - forceUpdate: mỗi lần trích xuất có bắt buộc sinh ra loại nút này hay không
 * - compression: NénCấu hình
 */
export const DEFAULT_NODE_SCHEMA = [
  {
    id: "event",
    label: "Sự kiện",
    tableName: "event_table",
    columns: [
      { name: "title", hint: "Tên sự kiện ngắn (khuyến nghị 6-10 ký tự, dùng để hiển thị trên đồ thị)", required: false },
      { name: "summary", hint: "Tóm tắt sự kiện, gồm quan hệ nhân quả và kết quả", required: true },
      { name: "participants", hint: "Tên nhân vật tham gia, phân tách bằng dấu phẩy", required: false },
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
        "Nén nút sự kiện thành tóm tắt mốc truyện có giá trị cao. Giữ lại quan hệ nhân quả, kết quả không thể đảo ngược và các manh mối cài cắm chưa được giải quyết.",
    },
  },
  {
    id: "character",
    label: "Nhân vật",
    tableName: "character_table",
    columns: [
      { name: "name", hint: "Tên nhân vật (chỉ tên chuẩn hóa)", required: true },
      { name: "traits", hint: "Đặc điểm tính cách ổn định và dấu hiệu ngoại hình", required: false },
      { name: "state", hint: "Trạng thái hoặc hoàn cảnh hiện tại", required: false },
      { name: "goal", hint: "Mục tiêu hoặc động cơ hiện tại", required: false },
      { name: "inventory", hint: "Vật phẩm then chốt đang mang theo hoặc sở hữu", required: false },
      { name: "core_note", hint: "Ghi chú then chốt đáng để nhớ lâu dài", required: false },
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
      { name: "name", hint: "Tên địa điểm (chỉ tên chuẩn hóa)", required: true },
      { name: "state", hint: "Trạng thái hiện tại hoặc điều kiện môi trường", required: false },
      { name: "features", hint: "Đặc điểm, tài nguyên hoặc dịch vụ quan trọng", required: false },
      { name: "danger", hint: "Cấp độ nguy hiểm hoặc mối đe dọa", required: false },
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
      { name: "title", hint: "Tên quy tắc ngắn", required: true },
      { name: "constraint", hint: "Nội dung quy tắc không được vi phạm", required: true },
      { name: "scope", hint: "Phạm vi/cảnh áp dụng", required: false },
      {
        name: "status",
        hint: "Hiệu lực hiện tại: active/suspended/revoked",
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
      { name: "summary", hint: "Tóm tắt tiến triển hiện tại", required: false },
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
      instruction: "Nén nút tuyến chính thành tóm tắt tiến triển theo giai đoạn. Giữ lại các bước ngoặt then chốt và mục tiêu hiện tại.",
    },
  },
  // ====== Loại nút mới của v2 ======
  {
    id: "synopsis",
    label: "Tóm lược toàn cục (cũ)",
    tableName: "synopsis_table",
    columns: [
      {
        name: "summary",
        hint: "Tóm lược toàn cục bối cảnh trước đó kiểu cũ dạng đơn mục (tương thích / đường lùi khi di chuyển)",
        required: true,
      },
      { name: "scope", hint: "Phạm vi tầng mà bản tóm lược kiểu cũ này bao phủ", required: false },
    ],
    alwaysInject: true, // tiêm thường trú (lấy cảm hứng từ MemoRAG)
    latestOnly: true, // chỉ giữ lại phiên bản mới nhất
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
      { name: "insight", hint: "Phản tư siêu nhận thức về hành vi nhân vật hoặc diễn biến cốt truyện", required: true },
      { name: "trigger", hint: "Sự kiện/mâu thuẫn kích hoạt phản tư", required: false },
      { name: "suggestion", hint: "Gợi ý cho diễn biến về sau", required: false },
    ],
    alwaysInject: false, // cần được truy hồi
    latestOnly: false,
    forceUpdate: false,
    compression: {
      mode: COMPRESSION_MODE.HIERARCHICAL,
      threshold: 6,
      fanIn: 3,
      maxDepth: 3,
      keepRecentLeaves: 3,
      instruction: "Hợp nhất các mục phản tư thành nguyên tắc chỉ đạo tự sự ở tầng cao hơn.",
    },
  },
  {
    id: "pov_memory",
    label: "Ký ức chủ quan",
    tableName: "pov_memory_table",
    columns: [
      { name: "summary", hint: "Góc nhìn này ghi nhớ sự việc này như thế nào", required: true },
      { name: "belief", hint: "Cô ấy/anh ấy cho rằng đã xảy ra điều gì", required: false },
      { name: "emotion", hint: "Phản ứng cảm xúc chủ quan", required: false },
      { name: "attitude", hint: "Thái độ với nhân vật hoặc sự kiện", required: false },
      {
        name: "certainty",
        hint: "Mức độ chắc chắn: certain/unsure/mistaken",
        required: false,
      },
      { name: "about", hint: "Đối tượng liên kết hoặc nhãn tham chiếu", required: false },
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
        "Nén ký ức chủ quan cùng góc nhìn và cùng quy thuộc nhân vật thành bản tóm tắt ký ức ngôi thứ nhất ổn định hơn, đồng thời giữ lại hiểu sai, cảm xúc và thay đổi thái độ.",
    },
  },
];

/**
 * Loại quan hệ đã chuẩn hóa
 */
export const RELATION_TYPES = [
  "related", // liên kết thông thường
  "involved_in", // tham giaSự kiện
  "occurred_at", // xảy ra tại địa điểm
  "advances", // thúc đẩytuyến chính
  "updates", // cập nhật trạng thái thực thể
  "contradicts", // mâu thuẫn/xung đột (dùng cho cạnh ức chế)
  "evolves", // liên kết tiến hóa A-MEM (mới → cũ)
  "temporal_update", // cập nhật theo thời gian (Graphiti: trạng thái mới thay thế trạng thái cũ)
];

/**
 * Kiểm tra tính hợp lệ của cấu hình schema
 * @param {Array} schema
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSchema(schema) {
  const errors = [];

  if (!Array.isArray(schema) || schema.length === 0) {
    errors.push("Schema bắt buộc phải là mảng không rỗng");
    return { valid: false, errors };
  }

  const ids = new Set();
  const tableNames = new Set();

  for (const type of schema) {
    if (!type || typeof type !== "object") {
      errors.push("Schema Loạiđịnh nghĩabắt buộcCóđối tượng");
      continue;
    }

    if (!type.id || typeof type.id !== "string") {
      errors.push("Mỗi loại bắt buộc phải có id");
      continue;
    }

    if (ids.has(type.id)) {
      errors.push(`Loại ID trùng lặp：${type.id}`);
    }
    ids.add(type.id);

    if (!type.label || typeof type.label !== "string") {
      errors.push(`Loại ${type.id}：thiếu label`);
    }

    if (!type.tableName || typeof type.tableName !== "string") {
      errors.push(`Loại ${type.id}：thiếu tableName`);
    } else if (tableNames.has(type.tableName)) {
      errors.push(`Tên bảng bị trùng: ${type.tableName}`);
    } else {
      tableNames.add(type.tableName);
    }

    if (!Array.isArray(type.columns) || type.columns.length === 0) {
      errors.push(`Loại ${type.id}: phải có ít nhất một cột`);
      continue;
    }

    const columnNames = new Set();
    for (const column of type.columns) {
      if (!column?.name || typeof column.name !== "string") {
        errors.push(`Loại ${type.id}: tồn tại định nghĩa cột thiếu name`);
        continue;
      }
      if (columnNames.has(column.name)) {
        errors.push(`Loại ${type.id}: tên cột bị trùng ${column.name}`);
      }
      columnNames.add(column.name);
    }

    const hasRequired = type.columns.some((c) => c?.required);
    if (!hasRequired) {
      errors.push(`Loại ${type.id}: phải có ít nhất một cột required`);
    }

    if (type.latestOnly) {
      const hasPrimaryLikeField = ["name", "title", "summary"].some(
        (fieldName) =>
          type.columns.some((column) => column?.name === fieldName),
      );
      if (!hasPrimaryLikeField) {
        errors.push(
          `Loại ${type.id}: loại latestOnly phải có ít nhất một trong các trường name/title/summary làm trường nhận diện chính`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Lấy định nghĩa của một loại trong schema
 * @param {Array} schema
 * @param {string} typeId
 * @returns {object|null}
 */
export function getSchemaType(schema, typeId) {
  return schema.find((t) => t.id === typeId) || null;
}

