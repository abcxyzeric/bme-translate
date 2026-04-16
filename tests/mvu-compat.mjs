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
  isMvuTaggedWorldInfoNameOrComment("thông thườngmục", "[initvar]"),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    "biếnCập nhậtQuy tắc:\ntype: state\nhiện tạiThời gian: 12:00",
  ),
  true,
);
assert.equal(
  isLikelyMvuWorldInfoContent(
    '{"stat_data":{"Địa điểm":"trường học"},"display_data":{"Địa điểm":"lớp học"}}',
  ),
  true,
);
assert.equal(isLikelyMvuWorldInfoContent("Bình thườngthế giớithiết lập"), false);

const aggressive = sanitizeMvuContent(
  "nội dung chính\n<updatevariable>hp=1</updatevariable>\n<status_current_variable>secret</status_current_variable>",
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
  "mô tảchữ\n<updatevariable>hp=1</updatevariable>\nđuôi",
  {
    mode: "final-safe",
  },
);
assert.equal(finalSafe.dropped, false);
assert.equal(finalSafe.text, "mô tảchữ\nđuôi");
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

const blocked = sanitizeMvuContent("tiền tố\nmục bị chặn\nhậu tố", {
  mode: "final-safe",
  blockedContents: ["mục bị chặn"],
});
assert.equal(blocked.text, "tiền tố\n\nhậu tố");
assert.equal(blocked.blockedHitCount, 1);
assert.deepEqual(blocked.reasons, ["blocked_content_removed"]);

console.log("mvu-compat tests passed");

