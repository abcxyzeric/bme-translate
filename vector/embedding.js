// ST-BME: đóng gói Embedding API bên ngoài + truy xuất vector
// Hỗ trợ giao diện /v1/embeddings tương thích OpenAI

/**
 * Dịch vụ Embedding
 * Gọi API bên ngoài để lấy vector văn bản và cung cấp tìm kiếm cosine độ tương đồng kiểu brute force
 */

import { extension_settings } from "../../../../extensions.js";
import { resolveConfiguredTimeoutMs } from "../runtime/request-timeout.js";

const MODULE_NAME = "st_bme";
const EMBEDDING_REQUEST_TIMEOUT_MS = 300000;

function getEmbeddingTestOverride(name) {
  const override = globalThis.__stBmeTestOverrides?.embedding?.[name];
  return typeof override === "function" ? override : null;
}

function getConfiguredTimeoutMs(
  settings = extension_settings[MODULE_NAME] || {},
) {
  return typeof resolveConfiguredTimeoutMs === "function"
    ? resolveConfiguredTimeoutMs(settings, EMBEDDING_REQUEST_TIMEOUT_MS)
    : (() => {
        const timeoutMs = Number(settings?.timeoutMs);
        return Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : EMBEDDING_REQUEST_TIMEOUT_MS;
      })();
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function normalizeOpenAICompatibleBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+(chat\/completions|embeddings)$/i, "")
    .replace(/\/+$/, "");
}

function createCombinedAbortSignal(...signals) {
  const validSignals = signals.filter(Boolean);
  if (validSignals.length <= 1) {
    return validSignals[0] || undefined;
  }

  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.any === "function"
  ) {
    return AbortSignal.any(validSignals);
  }

  const controller = new AbortController();
  for (const signal of validSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = EMBEDDING_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `Yêu cầu embedding quá thời gian (${Math.round(timeoutMs / 1000)}s)`,
          "AbortError",
        ),
      ),
    timeoutMs,
  );
  const signal = options.signal
    ? createCombinedAbortSignal(options.signal, controller.signal)
    : controller.signal;

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Gọi Embedding API bên ngoài
 *
 * @param {string} text - văn bản cần nhúng
 * @param {object} config - cấu hình API
 * @param {string} config.apiUrl - địa chỉ gốc của API (ví dụ https://api.openai.com/v1)
 * @param {string} config.apiKey - API Key
 * @param {string} config.model - tên model (ví dụ text-embedding-3-small)
 * @returns {Promise<Float64Array|null>} vector hoặc null
 */
export async function embedText(text, config, { signal } = {}) {
  const override = getEmbeddingTestOverride("embedText");
  if (override) {
    return await override(text, config, { signal });
  }

  const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  if (!text || !apiUrl || !config?.model) {
    console.warn("[ST-BME] Cấu hình Embedding chưa đầy đủ, bỏ qua");
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      `${apiUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        signal,
        body: JSON.stringify({
          model: config.model,
          input: text,
        }),
      },
      getConfiguredTimeoutMs(config),
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[ST-BME] Embedding API Lỗi (${response.status}):`,
        errorText,
      );
      return null;
    }

    const data = await response.json();
    const vector = data?.data?.[0]?.embedding;

    if (!vector || !Array.isArray(vector)) {
      console.error("[ST-BME] Embedding API trả vềđịnh dạngbất thường:", data);
      return null;
    }

    return new Float64Array(vector);
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    console.error("[ST-BME] Embedding API Gọi thất bại:", e);
    return null;
  }
}

/**
 * Nhúng văn bản theo lô
 *
 * @param {string[]} texts
 * @param {object} config
 * @returns {Promise<(Float64Array|null)[]>}
 */
export async function embedBatch(texts, config, { signal } = {}) {
  const override = getEmbeddingTestOverride("embedBatch");
  if (override) {
    return await override(texts, config, { signal });
  }

  const apiUrl = normalizeOpenAICompatibleBaseUrl(config?.apiUrl);
  if (!texts.length || !apiUrl || !config?.model) {
    return texts.map(() => null);
  }

  try {
    const response = await fetchWithTimeout(
      `${apiUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        signal,
        body: JSON.stringify({
          model: config.model,
          input: texts,
        }),
      },
      getConfiguredTimeoutMs(config),
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[ST-BME] Embedding API hàng loạtLỗi (${response.status}):`,
        errorText,
      );
      return texts.map(() => null);
    }

    const data = await response.json();
    const embeddings = data?.data;

    if (!Array.isArray(embeddings)) {
      return texts.map(() => null);
    }

    // Xếp lại theo index (API có thể không đảm bảo thứ tự)
    embeddings.sort((a, b) => a.index - b.index);

    return embeddings.map((item) => {
      if (item?.embedding && Array.isArray(item.embedding)) {
        return new Float64Array(item.embedding);
      }
      return null;
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    console.error("[ST-BME] Embedding API hàng loạtGọi thất bại:", e);
    return texts.map(() => null);
  }
}

/**
 * Tính cosine độ tương đồng của hai vector
 *
 * @param {Float64Array|number[]} vecA
 * @param {Float64Array|number[]} vecB
 * @returns {number} độ tương đồng [-1, 1]
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Tìm kiếm brute force: tìm ra Top-K nút giống nhất với vector truy vấn
 * Engine vector của PeroCore cũng có tìm kiếm brute force (khi <1000 nút thì nhanh hơn HNSW)
 *
 * @param {Float64Array|number[]} queryVec - vector truy vấn
 * @param {Array<{nodeId: string, embedding: Float64Array|number[]}>} candidates - Nút ứng viên
 * @param {number} topK - số lượng trả về
 * @returns {Array<{nodeId: string, score: number}>} sắp xếp giảm dần theo độ tương đồng
 */
export function searchSimilar(queryVec, candidates, topK = 20) {
  const override = getEmbeddingTestOverride("searchSimilar");
  if (override) {
    return override(queryVec, candidates, topK);
  }

  if (!queryVec || candidates.length === 0) return [];

  const scored = candidates
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((c) => ({
      nodeId: c.nodeId,
      score: cosineSimilarity(queryVec, c.embedding),
    }))
    .filter((item) => item.score > 0);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

/**
 * Kiểm tra khả năng kết nối của Embedding API
 *
 * @param {object} config - cấu hình API
 * @returns {Promise<{success: boolean, dimensions: number, error: string}>}
 */
export async function testConnection(config) {
  try {
    const vec = await embedText("test connection", config);
    if (vec) {
      return { success: true, dimensions: vec.length, error: "" };
    }
    return { success: false, dimensions: 0, error: "API trả về kết quả rỗng" };
  } catch (e) {
    return { success: false, dimensions: 0, error: String(e) };
  }
}
