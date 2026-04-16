import assert from "node:assert/strict";
import {
  createDefaultTaskProfiles,
  ensureTaskProfiles,
  getActiveTaskProfile,
  migrateLegacyProfileRegexToGlobal,
  migrateLegacyTaskProfiles,
  migratePerTaskRegexToGlobal,
  normalizeTaskProfile,
} from "../prompting/prompt-profiles.js";

const legacySettings = {
  extractPrompt: "Nhắc trích xuất cũ",
  recallPrompt: "Nhắc truy hồi cũ",
  compressPrompt: "",
  synopsisPrompt: "",
  reflectionPrompt: "",
  consolidationPrompt: "",
};

const migrated = migrateLegacyTaskProfiles(legacySettings);
assert.equal(migrated.taskProfilesVersion, 3);
assert.ok(migrated.taskProfiles);
assert.ok(migrated.taskProfiles.extract);
assert.ok(migrated.taskProfiles.recall);

const extractProfile = getActiveTaskProfile(
  {
    ...legacySettings,
    taskProfiles: migrated.taskProfiles,
  },
  "extract",
);
assert.equal(extractProfile.taskType, "extract");
assert.equal(extractProfile.id, "default");
assert.ok(Array.isArray(extractProfile.blocks));
assert.equal(extractProfile.blocks.length, 14);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.name),
  [
    "Phần mở đầu",
    "Định danh nhân vật",
    "Mô tả nhân vật",
    "Thiết lập người dùng",
    "Khối World Info phía trước",
    "Khối World Info phía sau",
    "Tin nhắn gần nhất",
    "Thống kê đồ thị",
    "Schema",
    "Phạm vi hiện tại",
    "Tóm tắt hoạt động",
    "Thời gian cốt truyện",
    "Định dạng đầu ra",
    "Quy tắc hành vi",
  ],
);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.type),
  [
    "custom",
    "custom",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "builtin",
    "custom",
    "custom",
  ],
);
assert.deepEqual(
  extractProfile.blocks.map((block) => block.role),
  [
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "system",
    "user",
    "user",
  ],
);
assert.equal(
  extractProfile.metadata.legacyPromptField,
  "extractPrompt",
);
assert.equal(
  extractProfile.metadata.legacyPromptSnapshot,
  "Nhắc trích xuất cũ",
);

const defaults = createDefaultTaskProfiles();
assert.ok(defaults.extract.profiles.length > 0);
assert.ok(defaults.recall.profiles.length > 0);
assert.ok(defaults.compress.profiles.length > 0);
assert.ok(defaults.synopsis.profiles.length > 0);
assert.ok(defaults.reflection.profiles.length > 0);
assert.deepEqual(
  defaults.recall.profiles[0].blocks.map((block) => block.sourceKey || block.id),
  [
    "default-heading",
    "default-role",
    "charDescription",
    "userPersona",
    "worldInfoBefore",
    "worldInfoAfter",
    "recentMessages",
    "userMessage",
    "candidateNodes",
    "sceneOwnerCandidates",
    "graphStats",
    "default-format",
    "default-rules",
  ],
);
assert.deepEqual(
  defaults.synopsis.profiles[0].blocks.map((block) => block.sourceKey || block.id),
  [
    "default-heading",
    "default-role",
    "charDescription",
    "userPersona",
    "worldInfoBefore",
    "worldInfoAfter",
    "recentMessages",
    "candidateText",
    "currentRange",
    "graphStats",
    "default-format",
    "default-rules",
  ],
);
assert.ok(defaults.summary_rollup.profiles.length > 0);

const upgradedLegacyDefault = getActiveTaskProfile(
  {
    taskProfilesVersion: 1,
    taskProfiles: {
      extract: {
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            taskType: "extract",
            builtin: true,
            blocks: [
              {
                id: "default-role",
                name: "Định danh nhân vật",
                type: "custom",
                role: "system",
                content: "giữ lại định danh nhân vật của riêng tôi",
                order: 0,
              },
              {
                id: "default-char-desc",
                name: "Mô tả nhân vật",
                type: "builtin",
                role: "system",
                sourceKey: "charDescription",
                order: 1,
              },
              {
                id: "default-user-persona",
                name: "Thiết lập người dùng",
                type: "builtin",
                role: "system",
                sourceKey: "userPersona",
                order: 2,
              },
              {
                id: "default-wi-before",
                name: "Khối World Info phía trước",
                type: "builtin",
                role: "system",
                sourceKey: "worldInfoBefore",
                order: 3,
              },
              {
                id: "default-wi-after",
                name: "Khối World Info phía sau",
                type: "builtin",
                role: "system",
                sourceKey: "worldInfoAfter",
                order: 4,
              },
              {
                id: "default-format",
                name: "Định dạng đầu ra",
                type: "custom",
                role: "system",
                content: "giữ lại định dạng đầu ra của riêng tôi",
                order: 5,
              },
              {
                id: "default-rules",
                name: "Quy tắc hành vi",
                type: "custom",
                role: "system",
                content: "giữ lại quy tắc hành vi của riêng tôi",
                order: 6,
              },
            ],
          },
        ],
      },
    },
  },
  "extract",
);
assert.equal(upgradedLegacyDefault.blocks.length, 14);
assert.equal(upgradedLegacyDefault.blocks[0].name, "Phần mở đầu");
assert.match(upgradedLegacyDefault.blocks[0].content, /thế giới ảo/);
assert.equal(upgradedLegacyDefault.blocks[0].role, "system");
assert.equal(upgradedLegacyDefault.blocks[0].injectionMode, "relative");
assert.equal(upgradedLegacyDefault.blocks[1].content, "giữ lại định danh nhân vật của riêng tôi");
assert.equal(upgradedLegacyDefault.blocks[12].content, "giữ lại định dạng đầu ra của riêng tôi");
assert.equal(upgradedLegacyDefault.blocks[13].content, "giữ lại quy tắc hành vi của riêng tôi");
assert.equal(upgradedLegacyDefault.blocks[12].role, "user");
assert.equal(upgradedLegacyDefault.blocks[13].role, "user");

const currentDefaults = createDefaultTaskProfiles();
const currentDefaultExtract = currentDefaults.extract.profiles[0];

const staleBuiltinDefaults = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          updatedAt: "2000-01-01T00:00:00.000Z",
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "đây là định danh nhân vật mặc định đã hết hạn" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
            defaultTemplateVersion:
              Number(currentDefaultExtract.metadata?.defaultTemplateVersion || 3),
            defaultTemplateUpdatedAt: "2000-01-01T00:00:00.000Z",
          },
        },
        {
          id: "extract-custom-1",
          taskType: "extract",
          builtin: false,
          name: "preset tự định nghĩa của tôi",
          promptMode: "block-based",
          enabled: true,
          updatedAt: "2026-04-05T00:00:00.000Z",
          blocks: [
            {
              id: "custom-block-1",
              name: "Khối tùy chỉnh",
              type: "custom",
              enabled: true,
              role: "system",
              sourceKey: "",
              sourceField: "",
              content: "giữ lại nội dung tự định nghĩa của tôi",
              injectionMode: "append",
              order: 0,
            },
          ],
          generation: { ...(currentDefaultExtract.generation || {}) },
          regex: {
            ...(currentDefaultExtract.regex || {}),
            localRules: [],
          },
          metadata: {
            note: "custom-profile-should-stay",
          },
        },
      ],
    },
  },
});
const refreshedDefaultExtract = staleBuiltinDefaults.extract.profiles.find(
  (profile) => profile.id === "default",
);
const preservedCustomExtract = staleBuiltinDefaults.extract.profiles.find(
  (profile) => profile.id === "extract-custom-1",
);

assert.ok(refreshedDefaultExtract);
assert.equal(
  refreshedDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
  currentDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
);
assert.equal(
  refreshedDefaultExtract.metadata.defaultTemplateUpdatedAt,
  currentDefaultExtract.metadata.defaultTemplateUpdatedAt,
);
assert.equal(
  refreshedDefaultExtract.metadata.defaultTemplateFingerprint,
  currentDefaultExtract.metadata.defaultTemplateFingerprint,
);
assert.match(
  refreshedDefaultExtract.blocks.find((block) => block.id === "default-format")
    ?.content || "",
  /cognitionUpdates/,
);
assert.ok(preservedCustomExtract);
assert.equal(
  preservedCustomExtract.blocks[0].content,
  "giữ lại nội dung tự định nghĩa của tôi",
);

const sameStampBuiltinDefault = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "giữ lại chỉnh sửa preset mặc định của tôi trong cùng phiên bản" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
          },
        },
      ],
    },
  },
});
const sameStampDefaultExtract = sameStampBuiltinDefault.extract.profiles.find(
  (profile) => profile.id === "default",
);
assert.equal(
  sameStampDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
  "giữ lại chỉnh sửa preset mặc định của tôi trong cùng phiên bản",
);

const sameTimestampButChangedTemplateDefaults = ensureTaskProfiles({
  taskProfilesVersion: 3,
  taskProfiles: {
    extract: {
      activeProfileId: "default",
      profiles: [
        {
          ...currentDefaultExtract,
          blocks: currentDefaultExtract.blocks.map((block) =>
            block.id === "default-role"
              ? { ...block, content: "nội dung mẫu cũ nhưng dấu thời gian không đổi" }
              : block,
          ),
          metadata: {
            ...(currentDefaultExtract.metadata || {}),
            defaultTemplateFingerprint: "fnv1a-deadbeef",
          },
        },
      ],
    },
  },
});
const fingerprintRefreshedDefault =
  sameTimestampButChangedTemplateDefaults.extract.profiles.find(
    (profile) => profile.id === "default",
  );
assert.equal(
  fingerprintRefreshedDefault.blocks.find(
    (block) => block.id === "default-role",
  )?.content,
  currentDefaultExtract.blocks.find((block) => block.id === "default-role")
    ?.content,
);

assert.deepEqual(
  upgradedLegacyDefault.blocks
    .slice(6, 10)
    .map((block) => block.sourceKey),
  ["recentMessages", "graphStats", "schema", "currentRange"],
);
assert.ok(
  upgradedLegacyDefault.blocks
    .slice(0, 12)
    .every((block) => block.role === "system"),
);

const legacyRegexSettings = {
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),
};
legacyRegexSettings.taskProfiles.extract.activeProfileId = "default";
legacyRegexSettings.taskProfiles.extract.profiles.push(
  normalizeTaskProfile("extract", {
    id: "extract-legacy-regex",
    taskType: "extract",
    name: "Bản sao regex cũ",
    builtin: false,
    regex: {
      enabled: true,
      inheritStRegex: true,
      localRules: [
        {
          id: "legacy-rule-1",
          script_name: "ẩnQuy tắc",
          enabled: true,
          find_regex: "/SECRET/g",
          replace_string: "MASK",
        },
      ],
    },
  }),
);
const migratedLegacyRegex = migratePerTaskRegexToGlobal(legacyRegexSettings);
assert.equal(migratedLegacyRegex.changed, true);
assert.equal(migratedLegacyRegex.settings.globalTaskRegex.enabled, true);
assert.deepEqual(
  migratedLegacyRegex.settings.globalTaskRegex.localRules.map((rule) => rule.script_name),
  [
    "Làm sạch mặc định: thinking/analysis/reasoning",
    "Làm sạch mặc định: choice",
    "Làm sạch mặc định: UpdateVariable",
    "Làm sạch mặc định: status_current_variable",
    "Làm sạch mặc định: StatusPlaceHolderImpl",
    "ẩnQuy tắc",
  ],
);
assert.deepEqual(
  migratedLegacyRegex.settings.taskProfiles.extract.profiles.find(
    (profile) => profile.id === "extract-legacy-regex",
  )?.regex?.localRules || [],
  [],
);

const existingGlobalRegexSettings = {
  taskProfilesVersion: 3,
  globalTaskRegex: {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      "input.userMessage": true,
      "input.recentMessages": true,
    },
    localRules: [
      {
        id: "existing-global-rule",
        script_name: "hiện có quy tắc dùng chung",
        enabled: true,
        find_regex: "/GLOBAL/g",
        replace_string: "KEEP",
      },
    ],
  },
  taskProfiles: createDefaultTaskProfiles(),
};
existingGlobalRegexSettings.taskProfiles.extract.profiles.push(
  normalizeTaskProfile("extract", {
    id: "extract-legacy-extra",
    taskType: "extract",
    name: "Quy tắc bổ sung cũ",
    builtin: false,
    regex: {
      localRules: [
        {
          id: "legacy-extra-rule",
          script_name: "Quy tắc cũ bổ sung thêm",
          enabled: true,
          find_regex: "/EXTRA/g",
          replace_string: "ADD",
        },
      ],
    },
  }),
);
const migratedWithExistingGlobal = migratePerTaskRegexToGlobal(
  existingGlobalRegexSettings,
);
assert.equal(migratedWithExistingGlobal.settings.globalTaskRegex.enabled, true);
assert.deepEqual(
  migratedWithExistingGlobal.settings.globalTaskRegex.localRules.map(
    (rule) => rule.script_name,
  ),
  ["hiện có quy tắc dùng chung", "Quy tắc cũ bổ sung thêm"],
);

const importedLegacyProfileMigration = migrateLegacyProfileRegexToGlobal(
  {
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      "input.userMessage": true,
      "input.recentMessages": true,
    },
    localRules: [],
  },
  {
    taskType: "extract",
    regex: {
      enabled: false,
      inheritStRegex: false,
      sources: {
        global: false,
        preset: false,
        character: false,
      },
      stages: {
        "input.userMessage": false,
      },
      localRules: [
        {
          id: "legacy-import-rule",
          script_name: "Quy tắc nhập cũ",
          enabled: true,
          find_regex: "/A/g",
          replace_string: "B",
        },
      ],
    },
  },
  {
    applyLegacyConfig: true,
  },
);
assert.equal(importedLegacyProfileMigration.appliedLegacyConfig, true);
assert.equal(importedLegacyProfileMigration.globalTaskRegex.enabled, false);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.inheritStRegex,
  false,
);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.sources.global,
  false,
);
assert.equal(
  importedLegacyProfileMigration.globalTaskRegex.stages["input.userMessage"],
  false,
);
assert.deepEqual(
  importedLegacyProfileMigration.globalTaskRegex.localRules.map(
    (rule) => rule.script_name,
  ),
  ["Quy tắc nhập cũ"],
);
assert.deepEqual(
  importedLegacyProfileMigration.profile?.regex || {},
  {},
);

console.log("task-profile-migration tests passed");

