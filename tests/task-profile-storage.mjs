import assert from "node:assert/strict";
import {
  cloneTaskProfile,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createDefaultTaskProfiles,
  createLocalRegexRule,
  exportTaskProfile,
  getActiveTaskProfile,
  getLegacyPromptFieldForTask,
  importTaskProfile,
  restoreDefaultTaskProfile,
  upsertTaskProfile,
} from "../prompting/prompt-profiles.js";

const taskProfiles = createDefaultTaskProfiles();
const baseProfile = taskProfiles.extract.profiles[0];
assert.equal(baseProfile.generation.llm_preset, "");

const clonedProfile = cloneTaskProfile(baseProfile, {
  taskType: "extract",
  name: "Trích xuất quyết liệt",
});
clonedProfile.generation.llm_preset = "Recall-API";
clonedProfile.blocks = [
  ...clonedProfile.blocks,
  createBuiltinPromptBlock("extract", "userMessage", {
    name: "Khối tin nhắn người dùng",
    injectionMode: "prepend",
    order: 1,
  }),
  createCustomPromptBlock("extract", {
    name: "bổ sungmô tả",
    content: "Hãy chú ý tới {{userMessage}}",
    role: "user",
    order: 2,
  }),
];
clonedProfile.regex.localRules = [
  createLocalRegexRule("extract", {
    script_name: "Cắt biên",
    find_regex: "/^foo/g",
    replace_string: "bar",
  }),
];

const updatedProfiles = upsertTaskProfile(taskProfiles, "extract", clonedProfile, {
  setActive: true,
});

const activeProfile = getActiveTaskProfile(
  { taskProfiles: updatedProfiles },
  "extract",
);
assert.equal(activeProfile.name, "Trích xuất quyết liệt");
assert.equal(activeProfile.blocks.length, 16);
const builtinBlock = activeProfile.blocks.find(
  (block) => block.type === "builtin" && block.sourceKey === "userMessage",
);
const customBlock = activeProfile.blocks.find(
  (block) => block.type === "custom" && block.name === "bổ sungmô tả",
);
assert.ok(builtinBlock);
assert.equal(builtinBlock.injectionMode, "prepend");
assert.equal(builtinBlock.role, "system");
assert.ok(customBlock);
assert.equal(customBlock.role, "user");
assert.equal(activeProfile.regex.localRules.length, 1);
assert.equal(activeProfile.regex.localRules[0].script_name, "Cắt biên");
assert.equal(activeProfile.generation.llm_preset, "Recall-API");

const exported = exportTaskProfile(
  updatedProfiles,
  "extract",
  clonedProfile.id,
);
assert.equal(exported.format, "st-bme-task-profile");
assert.equal(exported.taskType, "extract");
assert.equal(exported.profile.name, "Trích xuất quyết liệt");
assert.equal(exported.profile.generation.llm_preset, "Recall-API");

const imported = importTaskProfile(updatedProfiles, JSON.stringify(exported));
assert.equal(imported.taskType, "extract");
assert.notEqual(imported.profile.id, clonedProfile.id);
assert.equal(imported.profile.generation.llm_preset, "Recall-API");
assert.ok(
  imported.profile.blocks.some(
    (block) => block.type === "builtin" && block.sourceKey === "userMessage",
  ),
);

const restoredProfiles = restoreDefaultTaskProfile(imported.taskProfiles, "extract");
const restoredActive = getActiveTaskProfile(
  { taskProfiles: restoredProfiles },
  "extract",
);
assert.equal(restoredActive.id, "default");
assert.equal(getLegacyPromptFieldForTask("extract"), "extractPrompt");

console.log("task-profile-storage tests passed");

