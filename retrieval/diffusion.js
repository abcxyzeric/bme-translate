// ST-BME: engine kích hoạt khuếch tán PEDSA bản JS
// Chuyển thuật toán cốt lõi từ Rust CognitiveGraphEngine của PeroCore sang JS thuần
// Thích ứng với bối cảnh ST (<10 nghìn nút, không cần song song/SIMD)

/**
 * Engine kích hoạt khuếch tán PEDSA
 *
 * Thuật toán: Parallel Energy-Decay Spreading Activation
 * Bản chất: mô hình truyền năng lượng trên đồ thị có hướng có trọng số
 *
 * Công thức cốt lõi:
 *   E_{t+1}(j) = Σ_{i∈N(j)} E_t(i) × W_ij × D_decay
 *
 * Đặc điểm (giữ lại từ PeroCore):
 * - Suy hao năng lượng: mỗi bước truyền nhân với hệ số suy hao
 * - Cắt tỉa động: mỗi bước chỉ giữ lại Top-K nút hoạt động
 * - Cơ chế ức chế: loại cạnh đặc biệt truyền năng lượng âm
 * - Kẹp năng lượng: giới hạn trong khoảng [-2.0, 2.0]
 *
 * Khác biệt so với bản Rust của PeroCore:
 * - Không song song bằng Rayon (JS đơn luồng, bối cảnh ST không cần)
 * - Không lượng hóa u16 (dùng thẳng f64, bộ nhớ không phải nút thắt)
 * - Không SIMD (phép toán mảng thông thường)
 */

/**
 * Dấu hiệu loại cạnh ức chế
 */
const INHIBIT_EDGE_TYPE = 255;

/**
 * Mặc địnhCấu hình
 */
const DEFAULT_OPTIONS = {
  maxSteps: 2, // số bước khuếch tán tối đa
  decayFactor: 0.6, // hệ số suy hao mỗi bước
  topK: 100, // số nút hoạt động tối đa được giữ lại mỗi bước
  minEnergy: 0.01, // năng lượng hợp lệ tối thiểu (thấp hơn giá trị này thì xem là không hoạt động)
  maxEnergy: 2.0, // giới hạn trên của năng lượng
  minEnergy_clamp: -2.0, // giới hạn dưới của năng lượng (ức chế)
  teleportAlpha: 0.0, // xác suất kéo ngược kiểu PPR
  inhibitMultiplier: 2.0, // hệ số lan truyền âm của cạnh ức chế
};

/**
 * Thực thi kích hoạt khuếch tán PEDSA
 *
 * @param {Map<string, Array<{targetId: string, strength: number, edgeType: number}>>} adjacencyMap
 *   Bảng kề cận: nodeId → [{targetId, strength, edgeType}]
 *   Có thể xây dựng qua graph.buildAdjacencyMap()
 *
 * @param {Array<{id: string, energy: number}>} seedNodes
 *   Nút hạt giống ban đầu và năng lượng của chúng
 *   - Nút khớp qua truy xuất vector: energy = vectorScore (0~1)
 *   - Nút neo thực thể: energy = 2.0 (giá trị tối đa)
 *
 * @param {object} [options] - Cấu hìnhtùy chọn
 *
 * @returns {Map<string, number>} năng lượng cuối cùng của toàn bộ nút đã được kích hoạt
 *   nodeId → energy (giá trị dương = kích hoạt, giá trị âm = ức chế)
 */
export function propagateActivation(adjacencyMap, seedNodes, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const teleportAlpha = clamp01(opts.teleportAlpha);

  /** @type {Map<string, number>} */
  let currentEnergy = new Map();
  /** @type {Map<string, number>} */
  const initialEnergy = new Map();

  for (const seed of seedNodes || []) {
    if (!seed?.id) continue;
    const clamped = clampEnergy(Number(seed.energy) || 0, opts);
    if (Math.abs(clamped) >= opts.minEnergy) {
      const existing = currentEnergy.get(seed.id) || 0;
      const next = clampEnergy(existing + clamped, opts);
      currentEnergy.set(seed.id, next);
      initialEnergy.set(seed.id, next);
    }
  }

  // Kết quả tích lũy (năng lượng lớn nhất của mọi bước)
  /** @type {Map<string, number>} */
  const result = new Map(currentEnergy);

  // Bước 1~N: khuếch tán từng bước
  for (let step = 0; step < opts.maxSteps; step++) {
    /** @type {Map<string, number>} */
    const nextEnergy = new Map();

    // Với mỗi nút đang hoạt động hiện tại, truyền năng lượng tới nút lân cận
    for (const [nodeId, energy] of currentEnergy) {
      const neighbors = adjacencyMap.get(nodeId);
      if (!Array.isArray(neighbors) || neighbors.length === 0) continue;

      for (const neighbor of neighbors) {
        if (!neighbor?.targetId) continue;
        let propagated =
          energy *
          (Number(neighbor.strength) || 0) *
          opts.decayFactor *
          (1 - teleportAlpha);

        // Cạnh ức chế: truyền năng lượng âm
        if (neighbor.edgeType === INHIBIT_EDGE_TYPE) {
          propagated =
            -Math.abs(energy) *
            (Number(neighbor.strength) || 0) *
            opts.decayFactor *
            (Number(opts.inhibitMultiplier) || 1);
        }

        // Cộng dồn vào nút lân cận
        const existing = nextEnergy.get(neighbor.targetId) || 0;
        nextEnergy.set(neighbor.targetId, existing + propagated);
      }
    }

    // Kẹp + lọc năng lượng thấp
    for (const [nodeId, energy] of nextEnergy) {
      const clamped = clampEnergy(energy, opts);
      if (Math.abs(clamped) < opts.minEnergy) {
        nextEnergy.delete(nodeId);
      } else {
        nextEnergy.set(nodeId, clamped);
      }
    }

    if (teleportAlpha > 0) {
      for (const [nodeId, seedEnergy] of initialEnergy) {
        const current = nextEnergy.get(nodeId) || 0;
        const teleported =
          (1 - teleportAlpha) * current + teleportAlpha * seedEnergy;
        const clamped = clampEnergy(teleported, opts);
        if (Math.abs(clamped) >= opts.minEnergy) {
          nextEnergy.set(nodeId, clamped);
        } else {
          nextEnergy.delete(nodeId);
        }
      }
    }

    // Cắt tỉa động: chỉ giữ lại Top-K
    if (nextEnergy.size > opts.topK) {
      const sorted = [...nextEnergy.entries()].sort(
        (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
      );

      nextEnergy.clear();
      for (let i = 0; i < opts.topK && i < sorted.length; i++) {
        nextEnergy.set(sorted[i][0], sorted[i][1]);
      }
    }

    // Cập nhật kết quả tích lũy (lấy giá trị tuyệt đối lớn nhất ở các bước)
    for (const [nodeId, energy] of nextEnergy) {
      const existing = result.get(nodeId) || 0;
      if (Math.abs(energy) > Math.abs(existing)) {
        result.set(nodeId, energy);
      }
    }

    // Chuẩn bị cho bước tiếp theo
    currentEnergy = nextEnergy;

    // Nếu không còn nút hoạt động thì kết thúc sớm
    if (currentEnergy.size === 0) break;
  }

  return result;
}

/**
 * Kẹp năng lượng
 * @param {number} energy
 * @param {object} opts
 * @returns {number}
 */
function clampEnergy(energy, opts) {
  return Math.max(opts.minEnergy_clamp, Math.min(opts.maxEnergy, energy));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/**
 * Cách nhanh: tạo khuếch tán từ danh sách hạt giống và trả về kết quả xếp hạng theo năng lượng
 *
 * @param {Map} adjacencyMap - bảng kề cận
 * @param {Array<{id: string, energy: number}>} seeds - các nút hạt giống
 * @param {object} [options]
 * @returns {Array<{nodeId: string, energy: number}>} sắp xếp giảm dần theo năng lượng
 */
export function diffuseAndRank(adjacencyMap, seeds, options = {}) {
  const energyMap = propagateActivation(adjacencyMap, seeds, options);

  return [...energyMap.entries()]
    .filter(([_, energy]) => energy > 0)
    .map(([nodeId, energy]) => ({ nodeId, energy }))
    .sort((a, b) => {
      if (b.energy !== a.energy) return b.energy - a.energy;
      return String(a.nodeId).localeCompare(String(b.nodeId));
    });
}
