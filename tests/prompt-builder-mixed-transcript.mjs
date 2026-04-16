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
const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
const { initializeHostAdapter } = await import("../host/adapter/index.js");

initializeHostAdapter({});

const settings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};
const extractProfile = settings.taskProfiles.extract.profiles[0];
extractProfile.regex = {
  ...(extractProfile.regex || {}),
  enabled: true,
  inheritStRegex: false,
  sources: {
    global: false,
    preset: false,
    character: false,
  },
  stages: {
    ...(extractProfile.regex?.stages || {}),
    input: true,
    "input.recentMessages": true,
    "input.finalPrompt": false,
  },
  localRules: [
    {
      id: "assistant-local-role-aware",
      script_name: "assistant-local-role-aware",
      enabled: true,
      find_regex: "/tiếp tụcmô tả/g",
      replace_string: "trợ lý đã được làm sạch",
      source: {
        user_input: false,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
    },
    {
      id: "user-local-role-aware",
      script_name: "user-local-role-aware",
      enabled: true,
      find_regex: "/Người dùngđầu vào/g",
      replace_string: "Người dùng đã được làm sạch",
      source: {
        user_input: true,
        ai_output: false,
      },
      destination: {
        prompt: true,
        display: false,
      },
    },
  ],
};

const promptBuild = await buildTaskPrompt(settings, "extract", {
  taskName: "extract",
  charDescription: "",
  userPersona: "",
  recentMessages: "ở đây sẽ được chatMessages bù lại",
  chatMessages: [
    {
      seq: 41,
      role: "assistant",
      content: "tiếp tụcmô tả",
      name: "Ailin",
      speaker: "Ailin",
      hideSpeakerLabel: true,
      isContextOnly: true,
    },
    {
      seq: 42,
      role: "user",
      content: "Người dùngđầu vào",
      name: "người chơi",
      speaker: "người chơi",
      isContextOnly: false,
    },
  ],
  graphStats: "node_count=1",
  schema: "event(title, summary)",
  currentRange: "41 ~ 42",
});
const payload = buildTaskLlmPayload(promptBuild, "fallback-user");
const recentMessages = payload.promptMessages.filter(
  (message) => message.sourceKey === "recentMessages",
);
assert.deepEqual(
  recentMessages.map((message) => ({
    role: message.role,
    sourceKey: message.sourceKey,
    transcriptSection: message.transcriptSection,
    transcriptSectionPart: message.transcriptSectionPart,
  })),
  [
    {
      role: "system",
      sourceKey: "recentMessages",
      transcriptSection: "context",
      transcriptSectionPart: "section",
    },
    {
      role: "system",
      sourceKey: "recentMessages",
      transcriptSection: "target",
      transcriptSectionPart: "section",
    },
  ],
);
assert.match(String(recentMessages[0]?.content || ""), /^--- Dưới đây là phần nhìn lại ngữ cảnh (đã trích xuất), chỉ để hiểu cốt truyện ---/);
assert.match(String(recentMessages[0]?.content || ""), /#41 \[assistant\]: trợ lý đã được làm sạch/);
assert.match(String(recentMessages[1]?.content || ""), /^--- sau đây là phầnlầncầnTrích xuấtKý ứcmới củahội thoạiNội dung ---/);
assert.match(String(recentMessages[1]?.content || ""), /#42 \[user\|người chơi\]: Người dùng đã được làm sạch/);
assert.doesNotMatch(
  String(recentMessages[0]?.content || ""),
  /#41 \[assistant\|Ailin\]:/,
);
assert.doesNotMatch(
  String(recentMessages[1]?.content || ""),
  /#42 \[user\|người chơi\]: trợ lý đã được làm sạch/,
);

console.log("prompt-builder-mixed-transcript tests passed");

