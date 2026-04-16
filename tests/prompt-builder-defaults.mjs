import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '',",
  "    name2: '',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
].join("\n");

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
]);

const { buildTaskLlmPayload, buildTaskPrompt } = await import("../prompting/prompt-builder.js");
const {
  createDefaultGlobalTaskRegex,
  createDefaultTaskProfiles,
} = await import("../prompting/prompt-profiles.js");
const { initializeHostAdapter } = await import("../host/adapter/index.js");

const settings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};

const extractPromptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "Mô tả nhân vật",
  userPersona: "Thiết lập người dùng",
  recentMessages: "A: xin chào\nB: thế giới",
  graphStats: "node_count=3",
  schema: "event(title, summary)",
  currentRange: "1 ~ 2",
});
const extractPayload = buildTaskLlmPayload(extractPromptBuild, "fallback-user");
assert.equal(extractPayload.systemPrompt, "");
assert.equal(extractPayload.userPrompt, "");
assert.equal(
  extractPayload.promptMessages.filter((message) => message.role === "user").length,
  2,
);
assert.deepEqual(
  extractPayload.promptMessages
    .filter((message) => message.role === "user")
    .map((message) => message.blockName),
  ["Định dạng đầu ra", "Quy tắc hành vi"],
);
const extractFormatBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "Định dạng đầu ra",
);
const extractRulesBlock = extractPayload.promptMessages.find(
  (message) => message.blockName === "Quy tắc hành vi",
);
assert.match(String(extractFormatBlock?.content || ""), /cognitionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /regionUpdates/);
assert.match(String(extractFormatBlock?.content || ""), /batchStoryTime/);
assert.match(String(extractFormatBlock?.content || ""), /storyTime/);
assert.match(String(extractRulesBlock?.content || ""), /Tất cả nhân vật có liên quan đều cố gắng bổ sung cognitionUpdates/);
assert.match(String(extractRulesBlock?.content || ""), /batchStoryTime/);
assert.deepEqual(
  extractPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "recentMessages",
    "graphStats",
    "schema",
    "currentRange",
  ],
);

const recallPromptBuild = await buildTaskPrompt(settings, "recall", {
  taskName: "recall",
  charDescription: "Mô tả nhân vật",
  userPersona: "Thiết lập người dùng",
  recentMessages: "ngữ cảnh",
  userMessage: "phát ngôn mới nhất của người dùng",
  candidateNodes: "ứng viên 1\nứng viên 2",
  sceneOwnerCandidates: "character:alice\ncharacter:bob",
  graphStats: "candidate_count=2",
});
const recallPayload = buildTaskLlmPayload(recallPromptBuild, "fallback-user");
assert.equal(recallPayload.systemPrompt, "");
assert.equal(recallPayload.userPrompt, "");
assert.equal(
  recallPayload.promptMessages.filter((message) => message.role === "user").length,
  2,
);
assert.deepEqual(
  recallPayload.promptMessages
    .map((message) => message.sourceKey)
    .filter(Boolean),
  [
    "charDescription",
    "userPersona",
    "recentMessages",
    "userMessage",
    "candidateNodes",
    "sceneOwnerCandidates",
    "graphStats",
  ],
);
const recallFormatBlock = recallPayload.promptMessages.find(
  (message) => message.blockName === "Định dạng đầu ra",
);
const recallRulesBlock = recallPayload.promptMessages.find(
  (message) => message.blockName === "Quy tắc hành vi",
);
assert.match(String(recallFormatBlock?.content || ""), /active_owner_keys/);
assert.match(String(recallFormatBlock?.content || ""), /active_owner_scores/);
assert.match(String(recallFormatBlock?.content || ""), /selected_keys/);
assert.match(String(recallRulesBlock?.content || ""), /thời gian cốt truyện/);
assert.match(String(recallRulesBlock?.content || ""), /chấm điểm truy hồi/);

const globalRegexPromptBuild = await buildTaskPrompt(
  {
    taskProfilesVersion: 3,
    taskProfiles: createDefaultTaskProfiles(),
    globalTaskRegex: createDefaultGlobalTaskRegex(),
  },
  "recall",
  {
    taskName: "recall",
    recentMessages:
      "Tin nhắn gần nhất <thinking>suy nghĩ ẩn</thinking> <choice>1. ẩntùy chọn</choice>",
    userMessage:
      "Người dùngđầu vào <updatevariable>secret</updatevariable> <status_current_variable>hp=3</status_current_variable>",
    candidateNodes:
      "Nút ứng viên <StatusPlaceHolderImpl/> <analysis>phân tích ẩn</analysis>",
  },
);
assert.doesNotMatch(
  JSON.stringify(globalRegexPromptBuild),
  /<thinking|<choice|<updatevariable|<status_current_variable|<StatusPlaceHolderImpl|<analysis/i,
);

const formatterCalls = [];
initializeHostAdapter({
  regexProvider: {
    getTavernRegexes() {
      return [];
    },
    isCharacterTavernRegexesEnabled() {
      return true;
    },
    formatAsTavernRegexedString(text, source, destination, options) {
      formatterCalls.push({ text, source, destination, options });
      if (source === "ai_output") {
        return String(text || "").replace(/<action>.*?<\/action>/g, "");
      }
      if (source === "user_input") {
        return String(text || "").replace(/<u>|<\/u>/g, "");
      }
      return String(text || "");
    },
  },
});

const regexAwarePromptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "",
  userPersona: "",
  recentMessages: "ở đây sẽ được chatMessages bù lại",
  chatMessages: [
    {
      seq: 36,
      role: "assistant",
      content: "<action>vẫy tay</action>tiếp tục mô tả",
    },
    {
      seq: 37,
      role: "user",
      content: "Người dùng<u>đầu vào</u>",
    },
  ],
  graphStats: "node_count=1",
  schema: "event(title, summary)",
  currentRange: "36 ~ 37",
});
const regexAwarePayload = buildTaskLlmPayload(
  regexAwarePromptBuild,
  "fallback-user",
);
const regexAwareRecentBlock = regexAwarePayload.promptMessages.find(
  (message) => message.sourceKey === "recentMessages",
);
assert.match(String(regexAwareRecentBlock?.content || ""), /#36 \[assistant\]: tiếp tụcmô tả/);
assert.match(String(regexAwareRecentBlock?.content || ""), /#37 \[user\]: Người dùngđầu vào/);
assert.doesNotMatch(String(regexAwareRecentBlock?.content || ""), /action|<u>|<\/u>/i);
assert.equal(
  formatterCalls.some(
    (call) =>
      call.source === "ai_output" &&
      call.destination === "prompt" &&
      call.options?.depth === 1 &&
      call.options?.isPrompt === true,
  ),
  true,
);
assert.equal(
  formatterCalls.some(
    (call) =>
      call.source === "user_input" &&
      call.destination === "prompt" &&
      call.options?.depth === 0 &&
      call.options?.isPrompt === true,
  ),
  true,
);

initializeHostAdapter({});

console.log("prompt-builder-defaults tests passed");

