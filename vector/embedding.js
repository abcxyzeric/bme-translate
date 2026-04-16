// ST-BME: đóng gói Embedding API bên ngoài + truy xuất vector
// Hỗ trợ giao diện /v1/embeddings tương thích OpenAI

/**
 * Dịch vụ embedding
 * Gọi API bên ngoài để lấy vector văn bản và cung cấp tìm kiếm cosine
 * tương đồng kiểu brute force.
 */

import { extension_settings } from "../../../../extensions.js";
import { resolveConfiguredTimeoutMs } from "../runtime/request-timeout.js";

const MODULE_NAME = "st_bme";
const EMBEDDING_REQUEST_TIMEOUT_MS = 300000;
const EMBEDDING_KEY_POOL_STATE = new Map();

function getEmbeddingTestOverride(name) {
  const override = globalThis.__stBmeTestOverrides?.embedding?.[name];
  return typeof override === "function" ? override : null;
}

function getConfiguredTimeoutMs(settings = extension_settings[MODULE_NAME] || {}) {
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

function normalizeEmbeddingApiKeys(config = {}) {
  const fromArray = Array.isArray(config?.apiKeys)
    ? config.apiKeys
    : [config?.apiKey];
  return Array.from(
    new Set(
      fromArray
        .flatMap((item) => String(item || "").split(/\r?\n|[;,]/))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function buildEmbeddingPoolId(config = {}) {
  return [
    normalizeOpenAICompatibleBaseUrl(config?.apiUrl),
    String(config?.model || "").trim(),
  ].join("|");
}

function buildEmbeddingApiKeyAttempts(config = {}) {
  const apiKeys = normalizeEmbeddingApiKeys(config);
  if (apiKeys.length <= 1) {
    return {
      poolId: buildEmbeddingPoolId(config),
      apiKeys,
      attempts: apiKeys.length > 0 ? [{ apiKey: apiKeys[0], keyIndex: 0 }] : [{ apiKey: "", keyIndex: -1 }],
    };
  }

  const poolId = buildEmbeddingPoolId(config);
  const rawStartIndex = Number(EMBEDDING_KEY_POOL_STATE.get(poolId) || 0);
  const startIndex =
    Number.isFinite(rawStartIndex) && rawStartIndex >= 0
      ? rawStartIndex % apiKeys.length
      : 0;

  return {
    poolId,
    apiKeys,
    attempts: apiKeys.map((_, offset) => {
      const keyIndex = (startIndex + offset) % apiKeys.length;
      return {
        apiKey: apiKeys[keyIndex],
        keyIndex,
      };
    }),
  };
}

function commitEmbeddingApiKeySuccess(poolId, apiKeys, keyIndex) {
  if (!poolId || !Array.isArray(apiKeys) || apiKeys.length <= 1 || keyIndex < 0) {
    return;
  }
  EMBEDDING_KEY_POOL_STATE.set(poolId, (keyIndex + 1) % apiKeys.length);
}

function shouldRotateOnEmbeddingResponse(status, errorText = "", hasMoreKeys = false) {
  if (!hasMoreKeys) return false;
  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  ) {
    return true;
  }

  return /(rate limit|quota|insufficient_quota|too many requests|request limit|credit|billing|exhausted|capacity)/i.test(
    String(errorText || ""),
  );
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
 * @param {string} config.apiUrl - địa chỉ gốc của API
 * @param {string} config.apiKey - API key đầu tiên hoặc legacy single key
 * @param {string[]} [config.apiKeys] - danh sách API key để xoay vòng
 * @param {string} config.model - tên model
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

  const requestPlan = buildEmbeddingApiKeyAttempts(config);
  const totalAttempts = requestPlan.attempts.length;

  for (let attemptIndex = 0; attemptIndex < totalAttempts; attemptIndex++) {
    const attempt = requestPlan.attempts[attemptIndex];
    const hasMoreKeys = attemptIndex < totalAttempts - 1;

    try {
      const response = await fetchWithTimeout(
        `${apiUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(attempt.apiKey
              ? { Authorization: `Bearer ${attempt.apiKey}` }
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
        if (
          shouldRotateOnEmbeddingResponse(
            response.status,
            errorText,
            hasMoreKeys,
          )
        ) {
          console.warn(
            `[ST-BME] Embedding key ${
              attemptIndex + 1
            } bị giới hạn hoặc lỗi tạm thời, chuyển sang key tiếp theo`,
          );
          continue;
        }
        console.error(
          `[ST-BME] Embedding API lỗi (${response.status}):`,
          errorText,
        );
        return null;
      }

      const data = await response.json();
      const vector = data?.data?.[0]?.embedding;

      if (!vector || !Array.isArray(vector)) {
        console.error(
          "[ST-BME] Embedding API trả về định dạng bất thường:",
          data,
        );
        return null;
      }

      commitEmbeddingApiKeySuccess(
        requestPlan.poolId,
        requestPlan.apiKeys,
        attempt.keyIndex,
      );
      return new Float64Array(vector);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      console.error("[ST-BME] Gọi Embedding API thất bại:", error);
      return null;
    }
  }

  return null;
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

  const requestPlan = buildEmbeddingApiKeyAttempts(config);
  const totalAttempts = requestPlan.attempts.length;

  for (let attemptIndex = 0; attemptIndex < totalAttempts; attemptIndex++) {
    const attempt = requestPlan.attempts[attemptIndex];
    const hasMoreKeys = attemptIndex < totalAttempts - 1;

    try {
      const response = await fetchWithTimeout(
        `${apiUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(attempt.apiKey
              ? { Authorization: `Bearer ${attempt.apiKey}` }
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
        if (
          shouldRotateOnEmbeddingResponse(
            response.status,
            errorText,
            hasMoreKeys,
          )
        ) {
          console.warn(
            `[ST-BME] Embedding key ${
              attemptIndex + 1
            } bị giới hạn hoặc lỗi tạm thời, chuyển sang key tiếp theo`,
          );
          continue;
        }
        console.error(
          `[ST-BME] Embedding API hàng loạt lỗi (${response.status}):`,
          errorText,
        );
        return texts.map(() => null);
      }

      const data = await response.json();
      const embeddings = data?.data;

      if (!Array.isArray(embeddings)) {
        return texts.map(() => null);
      }

      embeddings.sort((left, right) => left.index - right.index);

      commitEmbeddingApiKeySuccess(
        requestPlan.poolId,
        requestPlan.apiKeys,
        attempt.keyIndex,
      );
      return embeddings.map((item) => {
        if (item?.embedding && Array.isArray(item.embedding)) {
          return new Float64Array(item.embedding);
        }
        return null;
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      console.error("[ST-BME] Gọi Embedding API hàng loạt thất bại:", error);
      return texts.map(() => null);
    }
  }

  return texts.map(() => null);
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
 *
 * @param {Float64Array|number[]} queryVec - vector truy vấn
 * @param {Array<{nodeId: string, embedding: Float64Array|number[]}>} candidates
 * @param {number} topK - số lượng trả về
 * @returns {Array<{nodeId: string, score: number}>}
 */
export function searchSimilar(queryVec, candidates, topK = 20) {
  const override = getEmbeddingTestOverride("searchSimilar");
  if (override) {
    return override(queryVec, candidates, topK);
  }

  if (!queryVec || candidates.length === 0) return [];

  const scored = candidates
    .filter((candidate) => candidate.embedding && candidate.embedding.length > 0)
    .map((candidate) => ({
      nodeId: candidate.nodeId,
      score: cosineSimilarity(queryVec, candidate.embedding),
    }))
    .filter((item) => item.score > 0);

  scored.sort((left, right) => right.score - left.score);

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
  } catch (error) {
    return { success: false, dimensions: 0, error: String(error) };
  }
}
