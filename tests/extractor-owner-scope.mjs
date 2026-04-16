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
  "    name2: '',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
  "export function substituteParamsExtended(value) {",
  "  return String(value QiuThuy '');",
  "}",
].join("\n");

const openAiShimSource = [
  "export const chat_completion_sources = {};",
  "export async function sendOpenAIRequest() {",
  "  throw new Error('sendOpenAIRequest should not be called in extractor-owner-scope test');",
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

const { createEmptyGraph, createNode, addNode } = await import("../graph/graph.js");
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
  name2: "",
  chatId: "test-chat",
};

{
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "Ailin" },
      seq: 1,
    }),
  );
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "Lucia" },
      seq: 1,
    }),
  );
  globalThis.__stBmeTestContext.name2 = "Thẻ nhóm";
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              action: "create",
              type: "pov_memory",
              fields: { summary: "Có người cảm thấy bên trong Tháp chuông vẫn còn vấn đề" },
            },
          ],
          cognitionUpdates: [
            {
              knownRefs: ["evt-missing"],
            },
          ],
          regionUpdates: {},
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 3, role: "assistant", content: "Kiểm thử cảnh nhiều người" }],
      startSeq: 3,
      endSeq: 3,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    assert.equal(
      graph.nodes.filter((node) => !node.archived && node.type === "pov_memory").length,
      0,
    );
    assert.ok(Array.isArray(result.ownerWarnings));
    assert.ok(
      result.ownerWarnings.some((warning) => warning.kind === "invalid-owner-scope"),
    );
  } finally {
    restore();
  }
}

{
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "Ailin" },
      seq: 1,
    }),
  );
  globalThis.__stBmeTestContext.name2 = "Ailin";
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              action: "create",
              type: "pov_memory",
              fields: { summary: "Ailin cảm thấy bên trong Tháp chuông còn giấu một mật đạo thứ hai" },
            },
          ],
          cognitionUpdates: [],
          regionUpdates: {},
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 5, role: "assistant", content: "Kiểm thử cảnh một nhân vật" }],
      startSeq: 5,
      endSeq: 5,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    const povNode = graph.nodes.find(
      (node) => !node.archived && node.type === "pov_memory",
    );
    assert.ok(povNode);
    assert.equal(povNode.scope?.ownerType, "character");
    assert.equal(povNode.scope?.ownerName, "Ailin");
  } finally {
    restore();
  }
}

{
  const graph = createEmptyGraph();
  globalThis.__stBmeTestContext.name1 = "QiuThuy";
  globalThis.__stBmeTestContext.name2 = "Thẻ nhóm";
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [
            {
              action: "create",
              type: "pov_memory",
              scope: {
                layer: "pov",
                ownerType: "character",
                ownerName: "Qiu Thuy",
                ownerId: "Qiu Thuy",
              },
              fields: { summary: "cô ấy cảm thấy đối phương đang thử dò giới hạn của mình" },
            },
          ],
          cognitionUpdates: [
            {
              ownerType: "character",
              ownerName: "【QiuThuy】",
              knownRefs: [],
            },
          ],
          regionUpdates: {},
        };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 7, role: "assistant", content: "Kiểm thử gắn nhầm tên người dùng" }],
      startSeq: 7,
      endSeq: 7,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, true);
    const povNode = graph.nodes.find(
      (node) => !node.archived && node.type === "pov_memory",
    );
    assert.ok(povNode);
    assert.equal(povNode.scope?.ownerType, "user");
    assert.equal(povNode.scope?.ownerName, "QiuThuy");
    const knowledgeOwners = Object.values(graph.knowledgeState?.owners || {});
    assert.equal(
      knowledgeOwners.some(
        (entry) =>
          String(entry?.ownerType || "") === "character" &&
          String(entry?.ownerName || "") === "QiuThuy",
      ),
      false,
    );
    assert.equal(
      knowledgeOwners.some(
        (entry) =>
          String(entry?.ownerType || "") === "user" &&
          String(entry?.ownerName || "") === "QiuThuy",
      ),
      true,
    );
  } finally {
    restore();
  }
}

console.log("extractor-owner-scope tests passed");

