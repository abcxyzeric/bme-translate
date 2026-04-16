import assert from "node:assert/strict";
import { formatInjection } from "../retrieval/injector.js";
import { DEFAULT_NODE_SCHEMA } from "../graph/schema.js";

const coreEvent = {
  id: "event-1",
  type: "event",
  scope: {
    layer: "objective",
    regionPrimary: "Tháp chuông",
  },
  fields: {
    summary: "Ailin在Tháp chuông发现了地下入口",
    participants: "Ailin",
    status: "resolved",
  },
  storyTime: {
    segmentId: "tl-1",
    label: "Sáng sớm ngày thứ hai",
    tense: "ongoing",
    relation: "same",
    anchorLabel: "",
    confidence: "high",
    source: "extract",
  },
};

const recalledCharacter = {
  id: "char-1",
  type: "pov_memory",
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerId: "Ailin",
    ownerName: "Ailin",
    regionPrimary: "Tháp chuông",
  },
  fields: {
    summary: "Ailin觉得地下室入口说明Tháp chuông里有人长期活动",
    belief: "这里藏着失踪案Manh mối",
    emotion: "警觉",
    attitude: "必须立刻下去查看",
  },
  storyTime: {
    segmentId: "tl-1",
    label: "Sáng sớm ngày thứ hai",
    tense: "ongoing",
    relation: "same",
    anchorLabel: "",
    confidence: "high",
    source: "extract",
  },
};

const recalledReflection = {
  id: "user-pov-1",
  type: "pov_memory",
  scope: {
    layer: "pov",
    ownerType: "user",
    ownerId: "người chơi",
    ownerName: "người chơi",
  },
  fields: {
    summary: "người chơi已经把Tháp chuông和失踪案牢牢绑定起来了",
    belief: "Tháp chuông地下室肯定有更深的秘密",
    emotion: "紧张",
    attitude: "希望Ailin谨慎推进",
  },
};

const recalledSynopsis = {
  id: "synopsis-1",
  type: "synopsis",
  scope: {
    layer: "objective",
  },
  fields: {
    summary: "昨夜冲突后，Ailin在Sáng sớm ngày thứ hai重新回到Tháp chuông，并发现地下入口与失踪案有直接联系。",
  },
  storyTimeSpan: {
    startSegmentId: "tl-0",
    endSegmentId: "tl-1",
    startLabel: "Sau xung đột đêm qua",
    endLabel: "Sáng sớm ngày thứ hai",
    mixed: true,
    source: "derived",
  },
};

const activeSummaryEntry = {
  id: "summary-l0-1",
  level: 0,
  kind: "small",
  status: "active",
  text: "Ailin刚在Tháp chuông重新站稳脚跟，并Xác nhận地下入口和失踪案直接相关，局面从调查转向即将下探。",
  sourceTask: "synopsis",
  extractionRange: [1, 3],
  messageRange: [2, 7],
  sourceBatchIds: ["batch-1", "batch-2", "batch-3"],
  sourceSummaryIds: [],
  sourceNodeIds: ["event-1"],
  storyTimeSpan: {
    startSegmentId: "tl-0",
    endSegmentId: "tl-1",
    startLabel: "Sau xung đột đêm qua",
    endLabel: "Sáng sớm ngày thứ hai",
    mixed: true,
    source: "derived",
  },
  regionHints: ["Tháp chuông"],
  ownerHints: ["Ailin"],
};

const text = formatInjection(
  {
    summaryEntries: [activeSummaryEntry],
    coreNodes: [coreEvent],
    recallNodes: [recalledCharacter, recalledReflection],
    scopeBuckets: {
      characterPov: [recalledCharacter],
      characterPovByOwner: {
        "character:Ailin": [recalledCharacter],
      },
      characterPovOwnerOrder: ["character:Ailin"],
      userPov: [recalledReflection],
      objectiveCurrentRegion: [coreEvent],
      objectiveGlobal: [recalledSynopsis],
    },
    meta: {
      retrieval: {
        sceneOwnerCandidates: [
          { ownerKey: "character:Ailin", ownerName: "Ailin" },
        ],
      },
    },
  },
  DEFAULT_NODE_SCHEMA,
);

assert.match(text, /\[Memory - Character POV: Ailin\]/);
assert.match(text, /\[Summary - Active Frontier\]/);
assert.match(text, /\[Summary L0 \/ Tầng 2 ~ 7\]/);
assert.match(text, /\[Memory - User POV \/ Not Character Facts\]/);
assert.match(text, /不等于Nhân vật已知事实/);
assert.match(text, /\[Memory - Objective \/ Current Region\]/);
assert.match(text, /pov_memory_table:/);
assert.match(text, /\| owner \| story_time \| summary \| belief \| emotion \| attitude \|/);
assert.match(text, /Nhân vật: Ailin/);
assert.match(text, /Người dùng: người chơi/);
assert.match(text, /event_table:/);
assert.match(text, /\| story_time \| summary \| participants \| status \|/);
assert.match(text, /Sáng sớm ngày thứ hai · ongoing/);
assert.match(text, /story_time_span/);
assert.match(text, /Sau xung đột đêm qua -> Sáng sớm ngày thứ hai/);

console.log("injector-format tests passed");
