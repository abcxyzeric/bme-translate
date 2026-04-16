import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return globalThis.__stBmeTestContext || {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: 'người chơi',",
  "    name2: 'Ailin',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
].join("\n");

const openAiShimSource = [
  "export const chat_completion_sources = {};",
  "export async function sendOpenAIRequest() {",
  "  throw new Error('sendOpenAIRequest should not be called in extractor-input-context test');",
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
  {
    specifiers: [
      "../../../../openai.js",
      "../../../../../openai.js",
    ],
    url: toDataModuleUrl(openAiShimSource),
  },
]);

const { createEmptyGraph } = await import("../graph/graph.js");
const { DEFAULT_NODE_SCHEMA } = await import("../graph/schema.js");
const { extractMemories } = await import("../maintenance/extractor.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

globalThis.__stBmeTestContext = {
  chat: [],
  chatMetadata: {},
  extensionSettings: {},
  powerUserSettings: {},
  characters: {},
  characterId: null,
  name1: "người chơi",
  name2: "Ailin",
  chatId: "test-chat",
};

const graph = createEmptyGraph();
let captured = null;
const restore = setTestOverrides({
  llm: {
    async callLLMForJSON(payload) {
      captured = payload;
      return {
        operations: [],
        cognitionUpdates: [],
        regionUpdates: {},
      };
    },
  },
});

try {
  const result = await extractMemories({
    graph,
    messages: [
      {
        seq: 10,
        role: "assistant",
        content: "<think></think>tiếp tụcmô tả",
        name: "Ailin",
        speaker: "Ailin",
      },
      {
        seq: 11,
        role: "user",
        content: "Người dùngđầu vào",
        name: "người chơi",
        speaker: "người chơi",
      },
    ],
    startSeq: 10,
    endSeq: 11,
    schema: DEFAULT_NODE_SCHEMA,
    embeddingConfig: null,
    settings: {
      extractAssistantExcludeTags: "think",
    },
  });

  assert.equal(result.success, true);
  assert.ok(captured);
  assert.ok(captured.debugContext);
  assert.ok(captured.debugContext.inputContext);
  assert.equal(captured.debugContext.inputContext.rawMessageCount, 2);
  assert.equal(captured.debugContext.inputContext.filteredMessageCount, 2);
  assert.equal(captured.debugContext.inputContext.changedAssistantMessageCount, 1);
  assert.equal(captured.debugContext.inputContext.excludedAssistantMessageCount, 1);

  const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
    (message) => message.sourceKey === "recentMessages",
  );
  assert.ok(recentBlock);
  assert.match(String(recentBlock?.content || ""), /#10 \[assistant\]: tiếp tụcmô tả/);
  assert.match(String(recentBlock?.content || ""), /#11 \[user\|người chơi\]: Người dùngđầu vào/);
  assert.doesNotMatch(String(recentBlock?.content || ""), /#10 \[assistant\|Ailin\]:/);
  assert.doesNotMatch(String(recentBlock?.content || ""), /|<think>/);
} finally {
  restore();
}

console.log("extractor-input-context tests passed");

