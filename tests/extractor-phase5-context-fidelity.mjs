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
  "  throw new Error('sendOpenAIRequest should not be called in phase5 fidelity test');",
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
const { defaultSettings } = await import("../runtime/settings-defaults.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

function collectAllPromptContent(captured) {
  return [
    String(captured.systemPrompt || ""),
    String(captured.userPrompt || ""),
    ...(Array.isArray(captured.promptMessages) ? captured.promptMessages : []).map(
      (message) => String(message.content || ""),
    ),
    ...(Array.isArray(captured.additionalMessages)
      ? captured.additionalMessages
      : []
    ).map((message) => String(message.content || "")),
  ].join("\n");
}

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  enabled = true,
  keys = [],
  positionType = "before_character_definition",
  role = "system",
  depth = 0,
  order = 10,
  strategyType = keys.length > 0 ? "selective" : "constant",
}) {
  return {
    uid,
    name,
    comment,
    content,
    enabled,
    position: {
      type: positionType,
      role,
      depth,
      order,
    },
    strategy: {
      type: strategyType,
      keys,
      keys_secondary: { logic: "and_any", keys: [] },
    },
    probability: 100,
    extra: {},
  };
}

const originalSillyTavern = globalThis.SillyTavern;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;
const originalTestContext = globalThis.__stBmeTestContext;

const worldbooksByName = {
  "main-book": [
    createWorldbookEntry({
      uid: 1,
      name: "Thiết lập thường trú của sách chính",
      content: "World Info chính: manh mối về chìa khóa xanh.",
      order: 10,
    }),
    createWorldbookEntry({
      uid: 2,
      name: "Chìa khóa xanhkích hoạtmục",
      content: "World Info chính khớp: khi điều tra chìa khóa xanh cần chú ý Khu phố cũ.",
      keys: ["Chìa khóa xanh"],
      order: 20,
    }),
  ],
  "persona-book": [
    createWorldbookEntry({
      uid: 3,
      name: "nhân cáchthiết lập",
      content: "World Info nhân cách: giữ sự cẩn trọng, đừng bỏ qua chi tiết lộ trình.",
      order: 10,
    }),
  ],
  "chat-book": [
    createWorldbookEntry({
      uid: 4,
      name: "chatgắnthiết lập",
      content: "World Info chat: phiên hiện tại đã khóa vào cuộc điều tra đêm mưa ở Khu phố cũ.",
      order: 10,
    }),
  ],
};

const fidelityMessages = [
  {
    seq: 30,
    role: "assistant",
    content: "<think>Phán đoán trước</think><action>Giơ đèn</action>Ailin nói: đi điều tra chìa khóa xanh.",
    name: "Ailin",
    speaker: "Ailin",
  },
  {
    seq: 31,
    role: "assistant",
    content: "Bổ sung của lời dẫn: <status mood='tense'>Đêm mưa</status>con hẻm rất yên tĩnh.",
    name: "lời dẫn",
    speaker: "lời dẫn",
  },
  {
    seq: 32,
    role: "user",
    content: "<plan>Ghi nhớ lộ trình trước</plan>Tôi sẽ tiếp tục điều tra chìa khóa xanh.",
    name: "người chơi",
    speaker: "người chơi",
  },
];

globalThis.__stBmeTestContext = {
  chat: [
    { is_user: false, mes: "Ailin nói: đi điều tra chìa khóa xanh.", name: "Ailin" },
    { is_user: false, mes: "Bổ sung của lời dẫn: Đêm mưa, con hẻm rất yên tĩnh.", name: "lời dẫn" },
    { is_user: true, mes: "Tôi sẽ tiếp tục điều tra chìa khóa xanh.", name: "người chơi" },
  ],
  chatMetadata: {
    world: "chat-book",
  },
  extensionSettings: {
    persona_description_lorebook: "persona-book",
  },
  powerUserSettings: {
    persona_description: "Thiết lập người dùng: người điều tra thận trọng",
  },
  characters: {
    1: {
      name: "Ailin",
      description: "Mô tả nhân vật: điều tra viên tuần đêm",
      data: {
        description: "Mô tả nhân vật: điều tra viên tuần đêm",
        extensions: {
          world: "main-book",
        },
      },
      extensions: {
        world: "main-book",
      },
    },
  },
  characterId: 1,
  name1: "người chơi",
  name2: "Ailin",
  chatId: "phase5-context-fidelity",
};

globalThis.SillyTavern = {
  getContext() {
    return globalThis.__stBmeTestContext;
  },
};

globalThis.getCharWorldbookNames = () => ({
  primary: "main-book",
  additional: [],
});
globalThis.getWorldbook = async (worldbookName) =>
  worldbooksByName[String(worldbookName || "").trim()] || [];
globalThis.getLorebookEntries = async (worldbookName) =>
  (worldbooksByName[String(worldbookName || "").trim()] || []).map((entry) => ({
    uid: entry.uid,
    comment: entry.comment,
  }));

try {
  {
    const graph = createEmptyGraph();
    let captured = null;
    const restore = setTestOverrides({
      llm: {
        async callLLMForJSON(payload) {
          captured = payload;
          return { operations: [], cognitionUpdates: [], regionUpdates: {} };
        },
      },
    });

    try {
      const result = await extractMemories({
        graph,
        messages: fidelityMessages,
        startSeq: 30,
        endSeq: 32,
        schema: DEFAULT_NODE_SCHEMA,
        embeddingConfig: null,
        settings: {
          ...defaultSettings,
          extractAssistantExcludeTags: "think,action",
          extractWorldbookMode: "active",
        },
      });

      assert.equal(result.success, true);
      assert.ok(captured);

      const allContent = collectAllPromptContent(captured);
      assert.match(allContent, /Mô tả nhân vật: điều tra viên tuần đêm/);
      assert.match(allContent, /Thiết lập người dùng: người điều tra thận trọng/);
      assert.match(allContent, /World Info chính: manh mối về chìa khóa xanh./);
      assert.match(allContent, /World Info chính khớp: khi điều tra chìa khóa xanh cần chú ý Khu phố cũ./);
      assert.match(allContent, /World Info nhân cách: giữ sự cẩn trọng, đừng bỏ qua chi tiết lộ trình./);
      assert.match(allContent, /World Info chat: phiên hiện tại đã khóa vào cuộc điều tra đêm mưa ở Khu phố cũ./);

      const recentBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "recentMessages");
      assert.ok(recentBlock, "recentMessages block should exist");
      const recentContent = String(recentBlock?.content || "");
      assert.match(recentContent, /#30 \[assistant\]: Ailin nói: đi điều tra chìa khóa xanh./);
      assert.match(
        recentContent,
        /#31 \[assistant\|lời dẫn\]: Bổ sung của lời dẫn: <status mood='tense'>Đêm mưa<\/status>con hẻm rất yên tĩnh./,
      );
      assert.match(
        recentContent,
        /#32 \[user\|người chơi\]: <plan>Ghi nhớ lộ trình trước<\/plan>Tôi sẽ tiếp tục điều tra chìa khóa xanh./,
      );
      assert.doesNotMatch(recentContent, /<think>|<action>/);

      const worldInfoBeforeBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "worldInfoBefore");
      assert.ok(worldInfoBeforeBlock, "worldInfoBefore block should exist when worldbook is active");
      assert.match(String(worldInfoBeforeBlock?.content || ""), /Chìa khóa xanhManh mối/);
    } finally {
      restore();
    }
  }

  {
    const graph = createEmptyGraph();
    let captured = null;
    const restore = setTestOverrides({
      llm: {
        async callLLMForJSON(payload) {
          captured = payload;
          return { operations: [], cognitionUpdates: [], regionUpdates: {} };
        },
      },
    });

    try {
      const result = await extractMemories({
        graph,
        messages: fidelityMessages,
        startSeq: 30,
        endSeq: 32,
        schema: DEFAULT_NODE_SCHEMA,
        embeddingConfig: null,
        settings: {
          ...defaultSettings,
          extractAssistantExcludeTags: "think,action",
          extractWorldbookMode: "none",
        },
      });

      assert.equal(result.success, true);
      assert.ok(captured);

      const allContent = collectAllPromptContent(captured);
      assert.match(allContent, /Mô tả nhân vật: điều tra viên tuần đêm/);
      assert.match(allContent, /Thiết lập người dùng: người điều tra thận trọng/);
      assert.doesNotMatch(allContent, /World Info chính: manh mối về chìa khóa xanh./);
      assert.doesNotMatch(allContent, /World Info chính khớp: khi điều tra chìa khóa xanh cần chú ý Khu phố cũ./);
      assert.doesNotMatch(allContent, /World Info nhân cách: giữ sự cẩn trọng, đừng bỏ qua chi tiết lộ trình./);
      assert.doesNotMatch(allContent, /World Info chat: phiên hiện tại đã khóa vào cuộc điều tra đêm mưa ở Khu phố cũ./);

      const recentBlock = (Array.isArray(captured.promptMessages)
        ? captured.promptMessages
        : []
      ).find((message) => message.sourceKey === "recentMessages");
      assert.ok(recentBlock, "recentMessages block should still exist when worldbook is disabled");
      assert.match(String(recentBlock?.content || ""), /#30 \[assistant\]: Ailin nói: đi điều tra chìa khóa xanh./);
    } finally {
      restore();
    }
  }
} finally {
  if (originalSillyTavern === undefined) {
    delete globalThis.SillyTavern;
  } else {
    globalThis.SillyTavern = originalSillyTavern;
  }
  if (originalGetCharWorldbookNames === undefined) {
    delete globalThis.getCharWorldbookNames;
  } else {
    globalThis.getCharWorldbookNames = originalGetCharWorldbookNames;
  }
  if (originalGetWorldbook === undefined) {
    delete globalThis.getWorldbook;
  } else {
    globalThis.getWorldbook = originalGetWorldbook;
  }
  if (originalGetLorebookEntries === undefined) {
    delete globalThis.getLorebookEntries;
  } else {
    globalThis.getLorebookEntries = originalGetLorebookEntries;
  }
  if (originalTestContext === undefined) {
    delete globalThis.__stBmeTestContext;
  } else {
    globalThis.__stBmeTestContext = originalTestContext;
  }
}

console.log("extractor-phase5-context-fidelity tests passed");




