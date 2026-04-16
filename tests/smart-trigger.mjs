import assert from "node:assert/strict";

import { getSmartTriggerDecision } from "../maintenance/smart-trigger.js";

const noTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "Hôm nay thời tiết không tệ." },
    { is_user: false, mes: "Ừ, chúng ta tiếp tục lên đường." },
  ],
  -1,
  { triggerPatterns: "", smartTriggerThreshold: 3 },
);
assert.equal(noTrigger.triggered, false);

const keywordTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "Chúng ta đột nhiên phát hiện dưới lòng lâu đài có bí mật." },
    { is_user: false, mes: "Hóa ra những người mất tích đều bị nhốt ở đây!" },
  ],
  -1,
  { triggerPatterns: "", smartTriggerThreshold: 2 },
);
assert.equal(keywordTrigger.triggered, true);
assert.ok(keywordTrigger.score >= 2);

const customTrigger = getSmartTriggerDecision(
  [
    { is_user: true, mes: "cô ấy khẽ nói ra sự thật." },
    { is_user: false, mes: "Mọi người đều im lặng." },
  ],
  -1,
  { triggerPatterns: "sự thật|phản bội", smartTriggerThreshold: 2 },
);
assert.equal(customTrigger.triggered, true);
assert.ok(customTrigger.reasons.some((reason) => reason.includes("kích hoạt tự định nghĩa")));

const ignoresProcessedMessages = getSmartTriggerDecision(
  [
    { is_user: true, mes: "Trước đó bỗng xuất hiện bí mật." },
    { is_user: false, mes: "Việc này đã được xử lý rồi." },
    { is_user: true, mes: "Hiện tại chỉ có đi đường một cách bình lặng." },
    { is_user: false, mes: "không cómớibất thường。" },
  ],
  1,
  { triggerPatterns: "", smartTriggerThreshold: 2 },
);
assert.equal(ignoresProcessedMessages.triggered, false);
assert.equal(ignoresProcessedMessages.score, 0);

const ignoresBlankAndInvalidRegex = getSmartTriggerDecision(
  [
    { is_system: true, mes: "hệ thốngtin nhắn" },
    { is_user: true, mes: "   " },
    { is_user: false, mes: "Thành Alpha đã xảy ra chuyện gì vậy?!" },
  ],
  -1,
  { triggerPatterns: "([\nsự thật", smartTriggerThreshold: 2 },
);
assert.equal(ignoresBlankAndInvalidRegex.triggered, true);
assert.ok(ignoresBlankAndInvalidRegex.reasons.includes("Dao động cảm xúc/xung đột"));

console.log("smart-trigger tests passed");

