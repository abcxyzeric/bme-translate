// ST-BME: mô-đun động lực học ký ức
// Hiện thực tăng cường truy cập, suy giảm theo thời gian và chấm điểm hỗn hợp — lấy từ đổi mới cốt lõi của PeroCore

/**
 * Tăng cường truy cập: được gọi khi nút bị truy hồi/tiêm
 * - accessCount += 1
 * - importance += 0.1 (giới hạn trên là 10)
 * - lastAccessTime Cập nhật
 *
 * @param {object} node
 */
export function reinforceAccess(node) {
    node.accessCount = (node.accessCount || 0) + 1;
    node.importance = Math.min(10, (node.importance || 5) + 0.1);
    node.lastAccessTime = Date.now();
}

/**
 * Tính toán hệ số suy giảm theo thời gian
 * Dùng suy giảm logarit (kiểu PeroCore) thay vì suy giảm mũ:
 * factor = 0.8 + 0.2 / (1 + ln(1 + Δt_days))
 *
 * Đặc điểm: ký ức cũ nhưng quan trọng sẽ không biến mất quá nhanh
 * - Δt = 0 ngày → factor = 1.0
 * - Δt = 1 ngày → factor ≈ 0.93
 * - Δt = 7 ngày → factor ≈ 0.89
 * - Δt = 30 ngày → factor ≈ 0.85
 * - Δt = 365 ngày → factor ≈ 0.83
 *
 * @param {number} createdTime - dấu thời gian tạo (ms)
 * @param {number} [now] - dấu thời gian hiện tại (ms)
 * @returns {number} hệ số suy giảm [0.8, 1.0]
 */
export function timeDecayFactor(createdTime, now = Date.now()) {
    const deltaDays = Math.max(0, (now - createdTime) / (1000 * 60 * 60 * 24));
    return 0.8 + 0.2 / (1 + Math.log(1 + deltaDays));
}

/**
 * Công thức chấm điểm hỗn hợp
 * FinalScore = (GraphScore×α + VecScore×β + ImportanceNorm×γ) × TimeDecay
 *
 * Mặc địnhtrọng số：α=0.6, β=0.3, γ=0.1
 *
 * @param {object} params
 * @param {number} params.graphScore - điểm năng lượng khuếch tán đồ thị [0, 2]
 * @param {number} params.vectorScore - Vectorđộ tương đồng [0, 1]
 * @param {number} params.importance - độ quan trọng của nút [0, 10]
 * @param {number} params.createdTime - thời gian tạo nút
 * @param {object} [weights] - trọng sốCấu hình
 * @returns {number} điểm cuối cùng
 */
export function hybridScore({
    graphScore = 0,
    vectorScore = 0,
    lexicalScore = 0,
    importance = 5,
    createdTime = Date.now(),
}, weights = {}) {
    const alpha = weights.graphWeight ?? 0.6;
    const beta = weights.vectorWeight ?? 0.3;
    const gamma = weights.importanceWeight ?? 0.1;
    const delta = weights.lexicalWeight ?? 0;

    // Chuẩn hóa
    const normGraph = Math.max(0, Math.min(1, graphScore / 2.0)); // phạm vi năng lượng PEDSA [-2, 2] → [0, 1]
    const normVec = Math.max(0, Math.min(1, vectorScore));
    const normLexical = Math.max(0, Math.min(1, lexicalScore));
    const normImportance = Math.max(0, Math.min(1, importance / 10.0));
    const totalWeight = Math.max(
        1e-6,
        Math.max(0, alpha) + Math.max(0, beta) + Math.max(0, gamma) + Math.max(0, delta),
    );

    const baseScore =
        (normGraph * alpha +
            normVec * beta +
            normLexical * delta +
            normImportance * gamma) /
        totalWeight;
    const decay = timeDecayFactor(createdTime);

    return baseScore * decay;
}

/**
 * Suy giảm trọng số cạnh: cạnh lâu không được kích hoạt sẽ giảm cường độ
 * Chỉ giảm tới mức thấp nhất 0.1, không về 0
 *
 * @param {object[]} edges
 * @param {Set<string>} activatedEdgeIds - ID các cạnh vừa được kích hoạt gần đây (xuất hiện trên đường khuếch tán)
 * @param {number} [decayRate=0.02] - lượng suy giảm mỗi lần gọi
 */
export function decayEdgeWeights(edges, activatedEdgeIds = new Set(), decayRate = 0.02) {
    for (const edge of edges) {
        if (activatedEdgeIds.has(edge.id)) {
            // Cạnh được kích hoạt sẽ được tăng nhẹ
            edge.strength = Math.min(1.0, edge.strength + decayRate * 0.5);
        } else {
            // Cạnh chưa được kích hoạt sẽ suy giảm nhẹ
            edge.strength = Math.max(0.1, edge.strength - decayRate);
        }
    }
}

/**
 * Thực thi tăng cường truy cập theo lô cho các nút đã chọn
 * @param {object[]} nodes - danh sách nút đã được truy hồi
 */
export function reinforceAccessBatch(nodes) {
    for (const node of nodes) {
        reinforceAccess(node);
    }
}
