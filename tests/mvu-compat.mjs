import assert from "node:assert/strict";

const {
  isLikelyMvuWorldInfoContent,
  isMvuTaggedWorldInfoNameOrComment,
  sanitizeMvuContent,
} = await import("../prompting/mvu-compat.js");

assert.equal(
  isMvuTaggedWorldInfoNameOrComment("[mvu_update] Trạng thái", ""),
  true,
);
assert.equal(
  isMvuTaggedWorldInfoNameOrComment("普通条目", "[initvar]"),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    "变量Cập nhậtQuy tắc:\ntype: state\n当前Thời gian: 12:00",
  ),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    '{"stat_data":{"Địa điểm":"学校"},"display_data":{"Địa điểm":"教室"}}',
  ),
  true,
);
assert.equal(isLikelyMvuWorldInfoContent("Bình thường世界thiết lập"), false);

const aggressive = sanitizeMvuContent(
  "正文\n<updatevariable>hp=1</updatevariable>\n<status_current_variable>secret</status_current_variable>",
  {
    mode: "aggressive",
  },
);
assert.equal(aggressive.text, "");
assert.equal(aggressive.dropped, true);
assert.deepEqual(
  aggressive.reasons.sort(),
  ["artifact_stripped", "likely_mvu_content"].sort(),
);

const finalSafe = sanitizeMvuContent(
  "说明文字\n<updatevariable>hp=1</updatevariable>\n尾巴",
  {
    mode: "final-safe",
  },
);
assert.equal(finalSafe.dropped, false);
assert.equal(finalSafe.text, "说明文字\n尾巴");
assert.deepEqual(finalSafe.reasons, ["artifact_stripped"]);

const macroSafe = sanitizeMvuContent(
  "Địa điểm={{get_message_variable::stat_data.Địa điểm}}\n<%- SafeGetValue(msg_data.Địa điểm) %>",
  {
    mode: "final-safe",
  },
);
assert.equal(macroSafe.dropped, false);
assert.equal(macroSafe.text, "Địa điểm=");
assert.deepEqual(macroSafe.reasons, ["artifact_stripped"]);

const blocked = sanitizeMvuContent("前缀\n被拦截条目\n后缀", {
  mode: "final-safe",
  blockedContents: ["被拦截条目"],
});
assert.equal(blocked.text, "前缀\n\n后缀");
assert.equal(blocked.blockedHitCount, 1);
assert.deepEqual(blocked.reasons, ["blocked_content_removed"]);

console.log("mvu-compat tests passed");
