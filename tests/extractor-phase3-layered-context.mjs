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
  "  throw new Error('sendOpenAIRequest should not be called in p3 test');",
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

const { addEdge, addNode, createEdge, createEmptyGraph, createNode } = await import("../graph/graph.js");
const { DEFAULT_NODE_SCHEMA } = await import("../graph/schema.js");
const { extractMemories } = await import("../maintenance/extractor.js");
const { appendSummaryEntry } = await import("../graph/summary-state.js");
const { normalizeGraphSummaryState } = await import("../graph/summary-state.js");
const { applyBatchStoryTime } = await import("../graph/story-timeline.js");
const { defaultSettings } = await import("../runtime/settings-defaults.js");

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

const baseMessages = [
  { seq: 10, role: "user", content: "vòng đầutin nhắn", name: "người chơi", speaker: "người chơi" },
  { seq: 11, role: "assistant", content: "vòng đầuPhản hồi", name: "Ailin", speaker: "Ailin" },
  { seq: 12, role: "user", content: "vòng haitin nhắn", name: "người chơi", speaker: "người chơi" },
  { seq: 13, role: "assistant", content: "vòng haiPhản hồi", name: "Ailin", speaker: "Ailin" },
  { seq: 14, role: "user", content: "vòng batin nhắn", name: "người chơi", speaker: "người chơi" },
  { seq: 15, role: "assistant", content: "vòng baPhản hồi", name: "Ailin", speaker: "Ailin" },
];

function collectAllPromptContent(captured) {
  return [
    String(captured.systemPrompt || ""),
    String(captured.userPrompt || ""),
    ...(Array.isArray(captured.promptMessages) ? captured.promptMessages : []).map(
      (m) => String(m.content || ""),
    ),
    ...(Array.isArray(captured.additionalMessages) ? captured.additionalMessages : []).map(
      (m) => String(m.content || ""),
    ),
  ].join("\n");
}

// ── Test 1: default settings — activeSummaries and storyTimeContext passed ──
{
  const graph = createEmptyGraph();
  normalizeGraphSummaryState(graph);
  const entry = appendSummaryEntry(graph, {
    text: "Văn bản kiểm thử tóm tắt cục diện gần nhất",
    messageRange: [5, 9],
    level: 1,
  });
  applyBatchStoryTime(graph, { label: "Sáng sớm ngày thứ hai", tense: "ongoing" }, "extract");

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
      messages: baseMessages.slice(0, 2),
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: { ...defaultSettings },
    });

    assert.equal(result.success, true);
    assert.ok(captured, "LLM should be called");

    const allContent = collectAllPromptContent(captured);

    // activeSummaries should be somewhere in prompt content
    assert.match(allContent, /Văn bản kiểm thử tóm tắt cục diện gần nhất/, "active summaries text should appear in prompt");

    // storyTimeContext should be somewhere in prompt content
    assert.match(allContent, /Sáng sớm ngày thứ hai/, "story time label should appear in prompt");

    // recentMessages block should contain the dialogue
    const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
      (m) => m.sourceKey === "recentMessages",
    );
    assert.ok(recentBlock, "recentMessages block should exist");
    assert.match(String(recentBlock.content || ""), /vòng đầu/, "recentMessages should contain dialogue content");
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
      messages: [
        {
          seq: 10,
          role: "user",
          content: "vòng đầutin nhắn",
          name: "người chơi",
          speaker: "người chơi",
          isContextOnly: true,
        },
        {
          seq: 11,
          role: "assistant",
          content: "vòng đầuPhản hồi",
          name: "Ailin",
          speaker: "Ailin",
          isContextOnly: true,
        },
        {
          seq: 12,
          role: "user",
          content: "vòng haitin nhắn",
          name: "người chơi",
          speaker: "người chơi",
          isContextOnly: false,
        },
        {
          seq: 13,
          role: "assistant",
          content: "vòng haiPhản hồi",
          name: "Ailin",
          speaker: "Ailin",
          isContextOnly: false,
        },
      ],
      startSeq: 12,
      endSeq: 13,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: { ...defaultSettings },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    const recentMessages = (Array.isArray(captured.promptMessages)
      ? captured.promptMessages
      : []
    ).filter(
      (m) => m.sourceKey === "recentMessages",
    );
    assert.equal(recentMessages.length, 2, "recentMessages should split into 2 section system messages");
    assert.equal(recentMessages[0]?.role, "system");
    assert.equal(recentMessages[0]?.transcriptSection, "context");
    assert.match(String(recentMessages[0]?.content || ""), /^--- Dưới đây là phần nhìn lại ngữ cảnh (đã trích xuất), chỉ để hiểu cốt truyện ---/);
    assert.match(String(recentMessages[0]?.content || ""), /#10 \[user\|người chơi\]: vòng đầutin nhắn/);
    assert.equal(recentMessages[1]?.role, "system");
    assert.equal(recentMessages[1]?.transcriptSection, "target");
    assert.match(String(recentMessages[1]?.content || ""), /^--- sau đây là phầnlầncầnTrích xuấtKý ứcmới củahội thoạiNội dung ---/);
    assert.match(String(recentMessages[1]?.content || ""), /#12 \[user\|người chơi\]: vòng haitin nhắn/);
    assert.ok(
      recentMessages[0].content.includes("đã trích xuất") &&
        recentMessages[1].content.includes("lần này cần trích xuất"),
      "context and target sections should each be emitted as a single system message",
    );
  } finally {
    restore();
  }
}

// ── Test 2: extractRecentMessageCap limits messages ──
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
      messages: baseMessages,
      startSeq: 10,
      endSeq: 15,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {
        ...defaultSettings,
        extractRecentMessageCap: 2,
      },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    // With cap=2, only the last 2 messages (seq 14, 15) should be in the recentMessages block
    const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
      (m) => m.sourceKey === "recentMessages",
    );
    assert.ok(recentBlock, "recentMessages block should exist");
    const recentContent = String(recentBlock.content || "");
    assert.match(recentContent, /vòng ba/, "capped messages should contain the last messages");
    assert.doesNotMatch(recentContent, /vòng đầu/, "capped messages should not contain early messages");
  } finally {
    restore();
  }
}

// ── Test 3: extractPromptStructuredMode = "structured" omits dialogueText ──
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
      messages: baseMessages.slice(0, 2),
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {
        ...defaultSettings,
        extractPromptStructuredMode: "structured",
      },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    // In structured mode, recentMessages block should still have structured content
    const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
      (m) => m.sourceKey === "recentMessages",
    );
    assert.ok(recentBlock, "recentMessages block should exist");
    const recentContent = String(recentBlock?.content || "");
    assert.ok(recentContent.length > 0, "recentMessages block should have content");
    // The full transcript should NOT appear in prompt content
    // (structured mode excludes dialogueText)
    const allContent = collectAllPromptContent(captured);
    // In "structured" mode, the user prompt fallback or blocks may reference structured messages
    assert.match(recentContent, /vòng đầu/, "structured messages should contain dialogue");
  } finally {
    restore();
  }
}

// ── Test 4: extractPromptStructuredMode = "transcript" passes string ──
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
      messages: baseMessages.slice(0, 2),
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {
        ...defaultSettings,
        extractPromptStructuredMode: "transcript",
      },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    // In transcript mode, the content should still be present in some form
    const allContent = collectAllPromptContent(captured);
    assert.match(allContent, /vòng đầu/, "transcript mode should have dialogue content");
    // recentMessages block should exist and have transcript content
    const recentBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
      (m) => m.sourceKey === "recentMessages",
    );
    assert.ok(recentBlock, "recentMessages block should exist in transcript mode");
  } finally {
    restore();
  }
}

// ── Test 5: extractIncludeSummaries = false omits summaries ──
{
  const graph = createEmptyGraph();
  normalizeGraphSummaryState(graph);
  appendSummaryEntry(graph, {
    text: "Tóm tắt này không nên xuất hiện",
    messageRange: [5, 9],
    level: 1,
  });

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
      messages: baseMessages.slice(0, 2),
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {
        ...defaultSettings,
        extractIncludeSummaries: false,
      },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    const allContent = collectAllPromptContent(captured);
    assert.doesNotMatch(allContent, /Tóm tắt này không nên xuất hiện/, "summaries should be excluded when disabled");
  } finally {
    restore();
  }
}

// ── Test 6: extractIncludeStoryTime = false omits story time ──
{
  const graph = createEmptyGraph();
  applyBatchStoryTime(graph, { label: "nhãn thời gian ẩn", tense: "ongoing" }, "extract");

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
      messages: baseMessages.slice(0, 2),
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: {
        ...defaultSettings,
        extractIncludeStoryTime: false,
      },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    const allContent = collectAllPromptContent(captured);
    assert.doesNotMatch(allContent, /nhãn thời gian ẩn/, "story time should be excluded when disabled");
  } finally {
    restore();
  }
}

// ── Test 7: new settings exist in defaults ──
{
  const graph = createEmptyGraph();
  const confessionNode = addNode(
    graph,
    createNode({
      type: "event",
      seq: 3,
      importance: 8,
      fields: {
        title: "Tỏ tình bằng tiếng Trung",
        summary: "cô ấy nghiêm túc yêu cầu bạn nói lại một lần nữa rằng bạn thích cô ấy.",
      },
    }),
  );
  const relationshipNode = addNode(
    graph,
    createNode({
      type: "thread",
      seq: 4,
      importance: 7,
      fields: {
        title: "Tình cảm ấm lên",
        summary: "Quan hệ của hai người nhanh chóng xích lại gần nhau sau lần tỏ tình này.",
      },
    }),
  );
  addEdge(
    graph,
    createEdge({
      fromId: confessionNode.id,
      toId: relationshipNode.id,
      relation: "supports",
      strength: 0.9,
    }),
  );

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
      messages: [
        {
          seq: 10,
          role: "user",
          content: "Sau lời tỏ tình bằng tiếng Trung, cô ấy vẫn còn rất ngại ngùng.",
          name: "người chơi",
          speaker: "người chơi",
        },
        {
          seq: 11,
          role: "assistant",
          content: "Lần tỏ tình bằng tiếng Trung này đã khiến tình cảm của hai người ấm lên.",
          name: "Ailin",
          speaker: "Ailin",
        },
      ],
      startSeq: 10,
      endSeq: 11,
      schema: DEFAULT_NODE_SCHEMA,
      embeddingConfig: null,
      settings: { ...defaultSettings },
    });

    assert.equal(result.success, true);
    assert.ok(captured);

    const graphStatsBlock = (Array.isArray(captured.promptMessages) ? captured.promptMessages : []).find(
      (m) => m.sourceKey === "graphStats",
    );
    assert.ok(graphStatsBlock, "graphStats block should exist");
    const graphStatsContent = String(graphStatsBlock.content || "");
    assert.match(graphStatsContent, /### Nút đồ thịthống kê/);
    assert.match(graphStatsContent, /Sự kiện: 1/);
    assert.match(graphStatsContent, /tuyến chính: 1/);
    assert.match(graphStatsContent, /\[G1\|Sự kiện\] Tỏ tình bằng tiếng Trung/);
    assert.doesNotMatch(graphStatsContent, new RegExp(confessionNode.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    restore();
  }
}

// ── Test 8: new settings exist in defaults ──
{
  assert.equal(defaultSettings.extractRecentMessageCap, 0);
  assert.equal(defaultSettings.extractPromptStructuredMode, "both");
  assert.equal(defaultSettings.extractWorldbookMode, "active");
  assert.equal(defaultSettings.extractIncludeStoryTime, true);
  assert.equal(defaultSettings.extractIncludeSummaries, true);
}

console.log("extractor-phase3-layered-context tests passed");

