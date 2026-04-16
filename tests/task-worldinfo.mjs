import assert from "node:assert/strict";
import {
  installResolveHooks,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const scriptShimSource = [
  "export function substituteParamsExtended(text) {",
  "  return String(text ?? '');",
  "}",
].join("\n");
const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;
const scriptShimUrl = `data:text/javascript,${encodeURIComponent(
  scriptShimSource,
)}`;

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: extensionsShimUrl,
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: scriptShimUrl,
  },
]);

const originalSillyTavern = globalThis.SillyTavern;
const originalEjsTemplate = globalThis.EjsTemplate;
const originalMvu = globalThis.Mvu;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  enabled = true,
  positionType = "before_character_definition",
  role = "system",
  depth = 0,
  order = 10,
  strategyType = "constant",
  keys = [],
  keysSecondary = [],
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
      keys_secondary: { logic: "and_any", keys: keysSecondary },
    },
    probability: 100,
    extra: {},
  };
}

function createConstantWorldbookEntry(uid, name, content, comment = name) {
  return createWorldbookEntry({
    uid,
    name,
    comment,
    content,
  });
}

const constantEntry = createWorldbookEntry({
  uid: 1,
  name: "thường trúthiết lập",
  comment: "thường trúthiết lập",
  content: "ở đâyCóthường trúthế giớithiết lập。",
  order: 10,
});

const dynEntry = createWorldbookEntry({
  uid: 2,
  name: "EW/Dyn/Manh mối",
  comment: "Manh mốimục",
  content: "ẩnManh mối：<%= charName %> đangđiều tra。",
  enabled: false,
  strategyType: "selective",
  keys: ["điều tra"],
  order: 15,
});

const inlineSummaryEntry = createWorldbookEntry({
  uid: 3,
  name: "thông thường EJS tổng hợp",
  comment: "EJS tổng hợp",
  content: 'Tóm tắt điều khiển：<%= await getwi("EW/Dyn/Manh mối") %>',
  order: 20,
});

const inlineDataSummaryEntry = createWorldbookEntry({
  uid: 12,
  name: "Dữ liệu EJS tổng hợp",
  comment: "Dữ liệu EJS tổng hợp",
  content:
    'Dữ liệutóm tắt：<%= await getwi("Dữ liệumẫu", { clue: "Chìa khóa xanh", mood: "căng thẳng" }) %>',
  order: 21,
});

const inlineDataTemplateEntry = createWorldbookEntry({
  uid: 13,
  name: "Dữ liệumẫu",
  comment: "Dữ liệumẫu",
  content:
    "Manh mối=<%= clue %>；Cảm xúc=<%= mood %>；Nhân vật=<%= char %>；Người dùng=<%= user %>；ngữ cảnh=<%= recentMessages %>",
  enabled: false,
  order: 22,
});

const commentKeywordProbeEntry = createWorldbookEntry({
  uid: 14,
  name: "ghi chúkhớp trúngKiểm thử",
  comment: "thường trúghi chú",
  content: "Mục này chỉ dùng để xác thực comment, không tham gia bộ lọc tự định nghĩa.",
  strategyType: "selective",
  keys: ["tuyệt đối sẽ không khớp ở đây"],
  order: 23,
});

const extensionLiteralEntry = createWorldbookEntry({
  uid: 4,
  name: "thân văn bản ngữ nghĩa extension",
  comment: "thân văn bản ngữ nghĩa extension",
  content: "@@generate\n[GENERATE:Test]\n.",
  order: 25,
});

const externalInlineEntry = createWorldbookEntry({
  uid: 5,
  name: "tổng hợp sách ngoài",
  comment: "tổng hợp sách ngoài",
  content: 'bên ngoàibổ sung：<%= await getwi("bonus-book", "Bonus mục") %>',
  order: 26,
});

const forceControlEntry = createWorldbookEntry({
  uid: 6,
  name: "điều khiển EJS thông thường",
  comment: "Điều khiển EJS",
  content: '<% await activewi("cưỡng chế after") %>',
  order: 30,
});

const forcedAfterEntry = createWorldbookEntry({
  uid: 7,
  name: "cưỡng chế after",
  comment: "cưỡng chếđặt sau",
  content: "Đây là mục đặt sau được EJS cưỡng chế kích hoạt.",
  enabled: false,
  positionType: "after_character_definition",
  strategyType: "selective",
  keys: ["không bao giờ khớp trúng"],
  order: 40,
});

const atDepthEntry = createWorldbookEntry({
  uid: 8,
  name: "độ sâuTiêm",
  comment: "độ sâuTiêm",
  content: "Đây là một tin nhắn atDepth.",
  positionType: "at_depth_as_system",
  depth: 2,
  order: 5,
});

const mvuTaggedEntry = createWorldbookEntry({
  uid: 9,
  name: "[mvu_update] Trạng tháiĐồng bộ",
  comment: "MVU tagged",
  content: "Mục này không nên đi vào kết quả.",
  order: 28,
});

const mvuHeuristicEntry = createWorldbookEntry({
  uid: 10,
  name: "mục heuristic MVU",
  comment: "MVU heuristic",
  content: "<status_current_variable>secret=true</status_current_variable>",
  order: 29,
});

const mvuLazyProbeEntry = createWorldbookEntry({
  uid: 11,
  name: "dò tải lười MVU",
  comment: "dò tải lười MVU",
  content: 'MVU lazy: <%= await getwi("bonus-book", "Bonus MVU") %>',
  order: 27,
});

const statDataControllerEntry = createWorldbookEntry({
  uid: 15,
  name: "StatData Controller",
  comment: "StatData Controller",
  content:
    '<% if (typeof stat_data !== "undefined" && stat_data?.user?.["\u610f\u8bc6\u72b6\u6001"] === "\u6c89\u7720") { %>stat_data controller payload<% } %>',
  order: 24,
});

const statDataTargetEntry = createWorldbookEntry({
  uid: 16,
  name: "StatData Target",
  comment: "StatData Target",
  content: "stat_data controller payload",
  enabled: false,
  order: 24.1,
});

const messageVarMacroEntry = createWorldbookEntry({
  uid: 17,
  name: "MessageVar Macro",
  comment: "MessageVar Macro",
  content: "latest state={{get_message_variable::stat_data.user.\u610f\u8bc6\u72b6\u6001}}",
  order: 24.2,
});

const customContextProbeEntry = createWorldbookEntry({
  uid: 18,
  name: "Custom Context Probe",
  comment: "Custom Context Probe",
  content: "thăm dò ngữ cảnh：user=<%= user_input %>;char=<%= charName %>",
  strategyType: "selective",
  keys: ["probe custom mode"],
  order: 24.3,
});
const bonusEntry = createWorldbookEntry({
  uid: 101,
  name: "Bonus mục",
  comment: "Bonus mục",
  content: "Nội dung bổ sung đến từ bonus-book.",
  order: 10,
});

  const bonusMvuEntry = createWorldbookEntry({
  uid: 102,
  name: "Bonus MVU",
  comment: "Bonus MVU",
  content: "biếnCập nhậtQuy tắc:\ntype: sync\nhiện tạiThời gian: 12:00",
  order: 20,
});

  const worldbooksByName = {
    "main-book": [
    constantEntry,
    dynEntry,
    inlineSummaryEntry,
    inlineDataSummaryEntry,
    inlineDataTemplateEntry,
    commentKeywordProbeEntry,
    extensionLiteralEntry,
    externalInlineEntry,
    mvuLazyProbeEntry,
    statDataControllerEntry,
    statDataTargetEntry,
    messageVarMacroEntry,
    customContextProbeEntry,
    forceControlEntry,
    forcedAfterEntry,
    atDepthEntry,
    mvuTaggedEntry,
    mvuHeuristicEntry,
    ],
    "bonus-book": [bonusEntry, bonusMvuEntry],
  };

try {
  globalThis.SillyTavern = {
    getContext() {
      return {
        name1: "User",
        name2: "Alice",
        chat: [{ is_user: true, mes: "Chúng ta tiếp tục điều tra manh mối đó" }],
        chatMetadata: {},
        extensionSettings: {},
      };
    },
  };
  globalThis.getCharWorldbookNames = () => ({
    primary: "main-book",
    additional: [],
  });
  globalThis.getWorldbook = async (worldbookName) =>
    worldbooksByName[worldbookName] || [];
  globalThis.getLorebookEntries = async (worldbookName) =>
    (worldbooksByName[worldbookName] || []).map((entry) => ({
      uid: entry.uid,
      comment: entry.comment,
    }));

  const { resolveTaskWorldInfo } = await import("../prompting/task-worldinfo.js");
  const { buildTaskPrompt, buildTaskLlmPayload } = await import(
    "../prompting/prompt-builder.js"
  );

  const emptyTriggerWorldInfo = await resolveTaskWorldInfo({
    chatMessages: [],
    userMessage: "",
    templateContext: {},
  });
  assert.equal(
    emptyTriggerWorldInfo.beforeEntries.some((entry) => entry.name === "thường trúthiết lập"),
    true,
    "constant world info should still resolve without trigger text",
  );
  assert.equal(
    emptyTriggerWorldInfo.beforeEntries.some((entry) => entry.name === "Dữ liệu EJS tổng hợp"),
    true,
    "constant EJS entry should still render with empty template context defaults",
  );
  assert.match(emptyTriggerWorldInfo.beforeText, /Dữ liệutóm tắt：Manh mối=Chìa khóa xanh；Cảm xúc=căng thẳng；Nhân vật=Alice；Người dùng=User；ngữ cảnh=/);
  assert.equal(
    emptyTriggerWorldInfo.debug.warnings.some((warning) => warning.includes("kết xuấtThất bại")),
    false,
  );

  const worldInfo = await resolveTaskWorldInfo({
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });
  assert.equal(worldInfo.beforeEntries.length, 6);
  assert.equal(worldInfo.afterEntries.length, 1);
  assert.equal(worldInfo.additionalMessages.length, 1);
  assert.match(worldInfo.additionalMessages[0].content, /atDepth/);
  assert.match(worldInfo.beforeText, /Alice/);
  assert.match(worldInfo.beforeText, /bonus-book/);
  assert.match(worldInfo.beforeText, /MVU lazy:/);
  assert.match(worldInfo.beforeText, /@@generate/);
  assert.match(worldInfo.beforeText, /\[GENERATE:Test\]/);
  assert.doesNotMatch(worldInfo.beforeText, /getwi|<%=?/);
  assert.doesNotMatch(worldInfo.beforeText, /status_current_variable|updatevariable/i);
  assert.equal(worldInfo.debug.ejsInlinePullCount, 3);
  assert.equal(worldInfo.debug.ejsForcedActivationCount, 1);
  assert.equal(worldInfo.debug.resolvePassCount >= 2, true);
  assert.equal(worldInfo.debug.forcedActivatedEntries.length, 1);
  assert.equal(worldInfo.debug.inlinePulledEntries.length, 3);
  assert.deepEqual(worldInfo.debug.lazyLoadedWorldbooks, ["bonus-book"]);
  assert.equal(worldInfo.debug.mvu.filteredEntryCount, 3);
  assert.equal(worldInfo.debug.mvu.lazyFilteredEntryCount, 1);
  assert.equal(worldInfo.debug.mvu.blockedContentsCount, 4);
  const defaultFilteredSourceNames = worldInfo.debug.mvu.filteredEntries
    .map((entry) => entry.sourceName)
    .sort();
  assert.equal(defaultFilteredSourceNames.includes("Bonus MVU"), true);
  assert.equal(defaultFilteredSourceNames.some((name) => String(name || "").includes("MVU")), true);
  assert.equal(defaultFilteredSourceNames.some((name) => String(name || "").startsWith("[mvu_update]")), true);
  assert.equal(
    worldInfo.debug.warnings.some((warning) => warning.includes("EW/")),
    true,
  );
  assert.equal(
    worldInfo.debug.recursionWarnings.some((warning) =>
      warning.includes("mvu filtered world info blocked"),
    ),
    true,
  );
  assert.equal(worldInfo.debug.customFilter.mode, "default");
  assert.equal(worldInfo.debug.customFilter.filteredEntryCount, 0);

  globalThis.Mvu = {
    getMvuData({ type, message_id: messageId } = {}) {
      if (type === "message" && messageId === "latest") {
        return {
          stat_data: {
            user: {
              "Trạng thái ý thức": "ngủ sâu",
            },
            "Nao Nao": {
              "Giá trị động dục": 71,
            },
          },
        };
      }
      return {};
    },
  };

  const customWorldInfo = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "",
    },
    templateContext: {
      recentMessages: "custom-mode regression probe",
      charName: "Alice",
    },
    userMessage: "probe custom mode",
  });

  assert.equal(
    customWorldInfo.beforeEntries.some((entry) =>
      String(entry.sourceName || "").startsWith("[mvu_update]"),
    ),
    true,
  );
  assert.equal(
    customWorldInfo.beforeEntries.some((entry) =>
      String(entry.sourceName || "").includes("MVU"),
    ),
    true,
  );
  assert.match(
    customWorldInfo.beforeText,
    /<status_current_variable>secret=true<\/status_current_variable>/,
  );
  assert.match(
    customWorldInfo.beforeText,
    /Tóm tắt điều khiển：ẩnManh mối：Alice đangđiều tra。/,
  );
  assert.match(
    customWorldInfo.beforeText,
    /thăm dò ngữ cảnh：user=probe custom mode;char=Alice/,
  );
  assert.equal(
    customWorldInfo.allEntries.some((entry) => String(entry.name || "").startsWith("EW/Dyn/")),
    true,
  );
  assert.equal(
    customWorldInfo.afterEntries.some((entry) => entry.sourceName === "cưỡng chế after"),
    true,
  );
  assert.equal(customWorldInfo.debug.mvu.filteredEntryCount, 0);
  assert.equal(customWorldInfo.debug.customFilter.mode, "custom");
  assert.equal(customWorldInfo.debug.customFilter.filteredEntryCount, 0);
  assert.equal(
    customWorldInfo.debug.customRender.bridgedStatDataFromLatestMessage,
    true,
  );
  assert.equal(customWorldInfo.debug.customRender.taskEjsStatDataRoots.cache, true);
  assert.equal(
    customWorldInfo.debug.customRender.taskEjsStatDataRoots.message,
    true,
  );
  assert.equal(customWorldInfo.debug.customRender.fallbackEntryCount > 0, true);
  assert.match(customWorldInfo.beforeText, /stat_data controller payload/);
  assert.match(customWorldInfo.beforeText, /latest state=.+/);

  globalThis.EjsTemplate = {
    async prepareContext() {
      return {
        user_input: "OLD_FROM_NATIVE",
        charName: "OLD_CHAR",
      };
    },
    async evalTemplate(text, env) {
      return String(text)
        .replace(/<%=\s*user_input\s*%>/g, String(env.user_input ?? ""))
        .replace(/<%=\s*charName\s*%>/g, String(env.charName ?? ""));
    },
  };

  const customWorldInfoWithNativeRuntime = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "",
    },
    templateContext: {
      recentMessages: "custom-mode regression probe",
      charName: "Alice",
    },
    userMessage: "probe custom mode",
  });

  assert.match(
    customWorldInfoWithNativeRuntime.beforeText,
    /thăm dò ngữ cảnh：user=probe custom mode;char=Alice/,
  );
  assert.doesNotMatch(
    customWorldInfoWithNativeRuntime.beforeText,
    /OLD_FROM_NATIVE|OLD_CHAR/,
  );
  delete globalThis.EjsTemplate;

  const keywordWorldInfo = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "thường trú",
    },
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });

  assert.equal(
    keywordWorldInfo.beforeEntries.some(
      (entry) => entry.sourceName === "thường trúthiết lập",
    ),
    false,
  );
  assert.equal(
    keywordWorldInfo.allEntries.some((entry) => entry.name === "ghi chúkhớp trúngKiểm thử"),
    true,
  );
  assert.equal(keywordWorldInfo.debug.customFilter.filteredEntryCount, 1);
  assert.equal(
    keywordWorldInfo.debug.customFilter.filteredEntries[0].name,
    "thường trúthiết lập",
  );
  assert.equal(
    keywordWorldInfo.debug.customFilter.filteredEntries[0].matchedKeyword,
    "thường trú",
  );

  const keywordCachePrime = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "thường trú,thăm dò bộ đệm",
    },
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });
  assert.equal(keywordCachePrime.debug.cache.hit, false);
  assert.equal(keywordCachePrime.debug.customFilter.filteredEntryCount, 1);

  const keywordCacheHit = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "thường trú,thăm dò bộ đệm",
    },
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });
  assert.equal(keywordCacheHit.debug.cache.hit, true);
  assert.equal(keywordCacheHit.debug.customFilter.filteredEntryCount, 1);
  assert.equal(
    keywordCacheHit.debug.customFilter.filteredEntries[0].name,
    "thường trúthiết lập",
  );

  delete globalThis.Mvu;

  const defaultModeWithKeywords = await resolveTaskWorldInfo({
    settings: {
      worldInfoFilterMode: "default",
      worldInfoFilterCustomKeywords: "thường trú",
    },
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });
  assert.equal(
    defaultModeWithKeywords.beforeEntries.some(
      (entry) => entry.sourceName === "thường trúthiết lập",
    ),
    true,
  );
  assert.equal(defaultModeWithKeywords.debug.mvu.filteredEntryCount > 0, true);
  assert.equal(defaultModeWithKeywords.debug.customFilter.filteredEntryCount, 0);

  const settings = {
    taskProfiles: {
      recall: {
        activeProfileId: "custom",
        profiles: [
          {
            id: "custom",
            name: "Kiểm thửpreset",
            taskType: "recall",
            builtin: false,
            blocks: [
              {
                id: "b1",
                type: "builtin",
                sourceKey: "worldInfoBefore",
                role: "system",
                enabled: true,
                order: 0,
                injectionMode: "append",
              },
              {
                id: "b2",
                type: "builtin",
                sourceKey: "worldInfoAfter",
                role: "system",
                enabled: true,
                order: 1,
                injectionMode: "append",
              },
              {
                id: "b3",
                type: "custom",
                content: "Nhân vật: {{charName}}",
                role: "user",
                enabled: true,
                order: 2,
                injectionMode: "append",
              },
            ],
          },
        ],
      },
    },
  };

  const promptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    userMessage: "tiếp tục điều tra",
    recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
    charName: "Alice",
  });

  assert.match(promptBuild.systemPrompt, /ở đâyCóthường trúthế giớithiết lập/);
  assert.match(promptBuild.systemPrompt, /Tóm tắt điều khiển：ẩnManh mối：Alice đangđiều tra/);
  assert.match(
    promptBuild.systemPrompt,
    /Dữ liệutóm tắt：Manh mối=Chìa khóa xanh；Cảm xúc=căng thẳng；Nhân vật=Alice；Người dùng=User；ngữ cảnh=Chúng ta tiếp tục điều tra manh mối đó/,
  );
  assert.match(promptBuild.systemPrompt, /ngữ nghĩa extension chỉ có văn bản thông thường/);
  assert.match(promptBuild.systemPrompt, /nội dung bổ sung đến từ bonus-book/);
  assert.match(promptBuild.systemPrompt, /MVU lazy:/);
  assert.doesNotMatch(promptBuild.systemPrompt, /getwi|<%=?/);
  assert.doesNotMatch(promptBuild.systemPrompt, /status_current_variable|biếnCập nhậtQuy tắc|updatevariable/i);
  assert.equal(
    promptBuild.privateTaskMessages.length,
    2,
    "custom user block + atDepth world info should both enter private task messages",
  );
  assert.deepEqual(
    promptBuild.privateTaskMessages.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(
    promptBuild.privateTaskMessages[0].content,
    "Đây là một tin nhắn atDepth.",
  );
  assert.deepEqual(
    promptBuild.hostInjections.before.map((entry) => entry.name),
    [
      "thường trúthiết lập",
      "EJS tổng hợp",
      "Dữ liệu EJS tổng hợp",
      "thân văn bản ngữ nghĩa extension",
      "tổng hợp sách ngoài",
      "dò tải lười MVU",
    ],
  );
  assert.deepEqual(
    promptBuild.hostInjections.after.map((entry) => entry.name),
    ["cưỡng chếđặt sau"],
  );
  assert.equal(promptBuild.hostInjections.atDepth.length, 1);
  assert.equal(promptBuild.hostInjections.atDepth[0].depth, 2);
  assert.equal(promptBuild.hostInjectionPlan.before.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.before[0].blockId, "b1");
  assert.equal(promptBuild.hostInjectionPlan.before[0].sourceKey, "worldInfoBefore");
  assert.deepEqual(promptBuild.hostInjectionPlan.before[0].entryNames, [
    "thường trúthiết lập",
    "EJS tổng hợp",
    "Dữ liệu EJS tổng hợp",
    "thân văn bản ngữ nghĩa extension",
    "tổng hợp sách ngoài",
    "dò tải lười MVU",
  ]);
  assert.equal(promptBuild.hostInjectionPlan.after.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.after[0].blockId, "b2");
  assert.equal(promptBuild.hostInjectionPlan.after[0].sourceKey, "worldInfoAfter");
  assert.deepEqual(promptBuild.hostInjectionPlan.after[0].entryNames, ["cưỡng chếđặt sau"]);
  assert.equal(promptBuild.hostInjectionPlan.atDepth.length, 1);
  assert.equal(promptBuild.hostInjectionPlan.atDepth[0].entryName, "độ sâuTiêm");
  assert.equal(typeof promptBuild.debug.worldInfoCacheHit, "boolean");
  assert.equal(promptBuild.executionMessages.length, 4);
  assert.deepEqual(
    promptBuild.executionMessages.map((message) => message.role),
    ["system", "system", "system", "user"],
  );
  assert.equal(
    promptBuild.executionMessages[0].content,
    "Đây là một tin nhắn atDepth.",
  );
  assert.deepEqual(
    promptBuild.renderedBlocks.map((block) => block.delivery),
    ["private.system", "private.system", "private.message"],
  );
  assert.equal(promptBuild.additionalMessages.length, 1);
  assert.equal(promptBuild.additionalMessages[0].content, "Đây là một tin nhắn atDepth.");
  assert.equal(promptBuild.debug.mvu.sanitizedFieldCount >= 0, true);

  const customPromptBuild = await buildTaskPrompt(
    {
      ...settings,
      worldInfoFilterMode: "custom",
      worldInfoFilterCustomKeywords: "",
    },
    "recall",
    {
      taskName: "recall",
      userMessage: "tiếp tục điều tra",
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
  );
  assert.match(
    customPromptBuild.systemPrompt,
    /<status_current_variable>secret=true<\/status_current_variable>/,
  );
  assert.match(customPromptBuild.systemPrompt, /Mục này không nên đi vào kết quả/);
  assert.match(customPromptBuild.systemPrompt, /Tóm tắt điều khiển：ẩnManh mối：Alice đangđiều tra/);
  const customPayload = buildTaskLlmPayload(customPromptBuild, "unused fallback");
  assert.equal(
    customPayload.promptMessages.some((message) =>
      /<status_current_variable>secret=true<\/status_current_variable>/.test(
        message.content,
      ),
    ),
    true,
  );

  const interpolatedSettings = {
    taskProfiles: {
      recall: {
        activeProfileId: "interpolated",
        profiles: [
          {
            id: "interpolated",
            name: "preset nội suy",
            taskType: "recall",
            builtin: false,
            blocks: [
              {
                id: "interp-system",
                type: "custom",
                content: "Nội suy World Info:\\n{{worldInfoBefore}}",
                role: "system",
                enabled: true,
                order: 0,
                injectionMode: "append",
              },
            ],
          },
        ],
      },
    },
    worldInfoFilterMode: "custom",
    worldInfoFilterCustomKeywords: "",
  };
  const customInterpolatedPromptBuild = await buildTaskPrompt(
    interpolatedSettings,
    "recall",
    {
      taskName: "recall",
      userMessage: "tiếp tục điều tra",
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
  );
  assert.match(
    customInterpolatedPromptBuild.systemPrompt,
    /<status_current_variable>secret=true<\/status_current_variable>/,
  );
  const customInterpolatedPayload = buildTaskLlmPayload(
    customInterpolatedPromptBuild,
    "unused fallback",
  );
  assert.equal(
    customInterpolatedPayload.promptMessages.some((message) =>
      /<status_current_variable>secret=true<\/status_current_variable>/.test(
        message.content,
      ),
    ),
    true,
  );

  const noWorldInfoBlockSettings = {
    taskProfiles: {
      recall: {
        activeProfileId: "custom",
        profiles: [
          {
            id: "custom",
            name: "không có khối World Info tường minh",
            taskType: "recall",
            builtin: false,
            blocks: [
              {
                id: "u1",
                type: "custom",
                content: "Nhân vật: {{charName}}",
                role: "user",
                enabled: true,
                order: 0,
                injectionMode: "append",
              },
            ],
          },
        ],
      },
    },
  };

  const atDepthOnlyPromptBuild = await buildTaskPrompt(
    noWorldInfoBlockSettings,
    "recall",
    {
      taskName: "recall",
      userMessage: "tiếp tục điều tra",
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
  );

  assert.equal(atDepthOnlyPromptBuild.debug.worldInfoRequested, true);
  assert.equal(atDepthOnlyPromptBuild.debug.worldInfoAtDepthCount, 1);
  assert.equal(atDepthOnlyPromptBuild.additionalMessages.length, 1);
  assert.equal(
    atDepthOnlyPromptBuild.additionalMessages[0].content,
    "Đây là một tin nhắn atDepth.",
  );
  assert.deepEqual(
    atDepthOnlyPromptBuild.executionMessages.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(
    atDepthOnlyPromptBuild.executionMessages[0].content,
    "Đây là một tin nhắn atDepth.",
  );

  const depthD4Entry = createWorldbookEntry({
    uid: 201,
    name: "độ sâuTiêm D4",
    comment: "độ sâuTiêm D4",
    content: "Đây là tin nhắn atDepth d4.",
    positionType: "at_depth_as_system",
    depth: 4,
    order: 8,
  });
  const depthD1Entry = createWorldbookEntry({
    uid: 202,
    name: "độ sâuTiêm D1",
    comment: "độ sâuTiêm D1",
    content: "Đây là tin nhắn atDepth d1.",
    positionType: "at_depth_as_system",
    depth: 1,
    order: 3,
  });
  worldbooksByName["main-book"].push(depthD4Entry, depthD1Entry);
  const previousGetContext = globalThis.SillyTavern.getContext;
  globalThis.SillyTavern.getContext = () => ({
    ...previousGetContext(),
    chatId: "depth-aware-chat",
  });

  const depthAwareSettings = {
    taskProfiles: {
      recall: {
        activeProfileId: "depth-aware",
        profiles: [
          {
            id: "depth-aware",
            name: "độ sâuthứ tựpreset",
            taskType: "recall",
            builtin: false,
            blocks: [
              {
                id: "depth-recent",
                type: "builtin",
                sourceKey: "recentMessages",
                role: "system",
                enabled: true,
                order: 0,
                injectionMode: "append",
              },
              {
                id: "depth-user",
                type: "custom",
                content: "Câu hỏi của người dùng: {{userMessage}}",
                role: "user",
                enabled: true,
                order: 1,
                injectionMode: "append",
              },
            ],
          },
        ],
      },
    },
  };

  const depthAwarePromptBuild = await buildTaskPrompt(depthAwareSettings, "recall", {
    taskName: "recall",
    userMessage: "tiếp tục điều tra depth xếp hạng",
    recentMessages: "ở đây sẽ được chatMessages thay thế",
    chatMessages: [
      { seq: 11, role: "user", content: "câu thứ nhất" },
      { seq: 12, role: "assistant", content: "câu thứ hai" },
    ],
    charName: "Alice",
  });

  assert.deepEqual(
    depthAwarePromptBuild.executionMessages.map((message) => message.content),
    [
      "#1 [assistant|độ sâuTiêm D4]: Đây là tin nhắn atDepth d4.\n\n#2 [assistant|độ sâuTiêm]: Đây là một tin nhắn atDepth.\n\n#11 [user]: câu thứ nhất\n\n#4 [assistant|độ sâuTiêm D1]: Đây là tin nhắn atDepth d1.\n\n#12 [assistant]: câu thứ hai",
      "Câu hỏi của người dùng: tiếp tục điều tra xếp hạng depth",
    ],
  );
  assert.deepEqual(
    depthAwarePromptBuild.hostInjections.atDepth.map((entry) => entry.name),
    ["độ sâuTiêm D4", "độ sâuTiêm", "độ sâuTiêm D1"],
  );
  assert.deepEqual(
    depthAwarePromptBuild.hostInjectionPlan.atDepth.map((entry) => entry.entryName),
    ["độ sâuTiêm D4", "độ sâuTiêm", "độ sâuTiêm D1"],
  );
  assert.equal(
    depthAwarePromptBuild.executionMessages.at(-1)?.content.includes("atDepth"),
    false,
  );
  worldbooksByName["main-book"].splice(-2, 2);
  globalThis.SillyTavern.getContext = previousGetContext;

  const { initializeHostAdapter } = await import("../host/adapter/index.js");
  const partialBridgeCalls = [];
  const partialBridgeEntriesByWorldbook = {
    "main-book": [createConstantWorldbookEntry(11, "Tên gốc sách chính", "Nội dung sách chính.", "Chú thích sách chính")],
    "side-book": [createConstantWorldbookEntry(12, "Tên gốc nhánh phụ", "Nội dung nhánh phụ.", "Chú thích nhánh phụ")],
    "persona-book": [createConstantWorldbookEntry(13, "Tên gốc nhân cách", "Nội dung nhân cách.", "Chú thích nhân cách")],
    "chat-book": [createConstantWorldbookEntry(14, "Tên gốc chat", "Nội dung chat.", "Chú thích chat")],
  };

  globalThis.SillyTavern = {
    getContext() {
      return {
        name1: "User",
        name2: "Alice",
        chat: [{ is_user: true, mes: "Chúng ta tiếp tục điều tra manh mối đó" }],
        chatMetadata: {
          world: "chat-book",
        },
        extensionSettings: {
          persona_description_lorebook: "persona-book",
        },
      };
    },
  };
  globalThis.getCharWorldbookNames = () => ({
    primary: "main-book",
    additional: ["side-book"],
  });
  globalThis.getWorldbook = async () => {
    throw new Error(
      "legacy getWorldbook should not be used when bridge getWorldbook is available",
    );
  };
  globalThis.getLorebookEntries = async (worldbookName) =>
    (partialBridgeEntriesByWorldbook[worldbookName] || []).map((entry) => ({
      uid: entry.uid,
      comment: entry.comment,
    }));

  initializeHostAdapter({
    worldbookProvider: {
      async getWorldbook(worldbookName) {
        partialBridgeCalls.push(worldbookName);
        return partialBridgeEntriesByWorldbook[worldbookName] || [];
      },
    },
  });

  const partialBridgeWorldInfo = await resolveTaskWorldInfo({
    templateContext: {
      recentMessages: "Chúng ta tiếp tục điều tra manh mối đó",
      charName: "Alice",
    },
    userMessage: "tiếp tục điều tra",
  });

  assert.deepEqual(partialBridgeCalls, [
    "main-book",
    "side-book",
    "persona-book",
    "chat-book",
  ]);
  assert.deepEqual(
    partialBridgeWorldInfo.beforeEntries.map((entry) => entry.name).sort(),
    ["Chú thích sách chính", "Chú thích nhánh phụ", "Chú thích nhân cách", "Chú thích chat"].sort(),
  );

  console.log("task-worldinfo tests passed");
} finally {
  if (originalSillyTavern === undefined) {
    delete globalThis.SillyTavern;
  } else {
    globalThis.SillyTavern = originalSillyTavern;
  }

  if (originalEjsTemplate === undefined) {
    delete globalThis.EjsTemplate;
  } else {
    globalThis.EjsTemplate = originalEjsTemplate;
  }

  if (originalMvu === undefined) {
    delete globalThis.Mvu;
  } else {
    globalThis.Mvu = originalMvu;
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

  try {
    const { initializeHostAdapter } = await import("../host/adapter/index.js");
    initializeHostAdapter({});
  } catch {
    // ignore reset failures in test cleanup
  }
}


