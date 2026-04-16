import { isSystemMessageForExtraction } from "./chat-history.js";

export const DEFAULT_TRIGGER_KEYWORDS = [
  "đột nhiên",
  "không ngờ",
  "thì ra",
  "thật ra",
  "phát hiện ra",
  "phản bội",
  "cái chết",
  "hồi sinh",
  "Khôi phụcKý ức",
  "mất trí nhớ",
  "tỏ tình",
  "bại lộ",
  "bí mật",
  "kế hoạch",
  "Quy tắc",
  "khế ước",
  "vị trí",
  "Địa điểm",
  "rời đi",
  "đến nơi",
];

export function getSmartTriggerDecision(
  chat,
  lastProcessed,
  settings,
  endFloor = null,
) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const startFloor = Math.max(0, (lastProcessed ?? -1) + 1);
  const normalizedEndFloor =
    endFloor == null || endFloor === ""
      ? null
      : Number.isFinite(Number(endFloor))
        ? Math.max(startFloor - 1, Math.floor(Number(endFloor)))
        : null;
  const pendingMessages = safeChat
    .slice(
      startFloor,
      normalizedEndFloor == null ? undefined : normalizedEndFloor + 1,
    )
    .map((msg, offset) => ({
      msg,
      index: startFloor + offset,
    }))
    .filter(({ msg, index }) =>
      !isSystemMessageForExtraction(msg, { index, chat: safeChat }),
    )
    .map(({ msg }) => ({
      role: msg.is_user ? "user" : "assistant",
      content: msg.mes || "",
    }))
    .filter((msg) => msg.content.trim().length > 0);

  if (pendingMessages.length === 0) {
    return { triggered: false, score: 0, reasons: [] };
  }

  const reasons = [];
  let score = 0;
  const combinedText = pendingMessages.map((message) => message.content).join("\n");

  const keywordHits = DEFAULT_TRIGGER_KEYWORDS.filter((keyword) =>
    combinedText.includes(keyword),
  );
  if (keywordHits.length > 0) {
    score += Math.min(2, keywordHits.length);
    reasons.push(`Từ khóa then chốt: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  const customPatterns = String(settings?.triggerPatterns || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const pattern of customPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(combinedText)) {
        score += 2;
        reasons.push(`Kích hoạt tự định nghĩa: ${pattern}`);
        break;
      }
    } catch {
      // Bỏ qua regex không hợp lệ để tránh ảnh hưởng luồng chính
    }
  }

  const roleSwitchCount = pendingMessages.reduce((count, message, index) => {
    if (index === 0) return count;
    return count + (message.role !== pendingMessages[index - 1].role ? 1 : 0);
  }, 0);
  if (roleSwitchCount >= 2) {
    score += 1;
    reasons.push("Tương tác qua lại nhiều lượt");
  }

  const punctuationHits = (combinedText.match(/[!?！？]/g) || []).length;
  if (punctuationHits >= 2) {
    score += 1;
    reasons.push("Biến động cảm xúc/xung đột");
  }

  const entityLikeHits =
    combinedText.match(
      /[A-ZÀ-Ỹ][A-Za-zÀ-ỹ]{2,}|[A-Za-zÀ-ỹ]{2,20}(vương quốc|thành phố|thị trấn|ngôi làng|học viện|tổ chức|công ty|tiểu đội|quân đoàn)/g,
    ) || [];
  if (entityLikeHits.length > 0) {
    score += 1;
    reasons.push("Nghi có thực thể mới/địa điểm mới");
  }

  const threshold = Math.max(1, settings?.smartTriggerThreshold || 2);
  return {
    triggered: score >= threshold,
    score,
    reasons,
  };
}

