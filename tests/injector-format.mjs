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
    summary: "Ailin đã phát hiện ra lối vào dưới đất trong Tháp chuông",
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
    summary: "Ailin cảm thấy lối vào tầng hầm cho thấy bên trong Tháp chuông có người hoạt động lâu dài",
    belief: "ở đây giấu manh mối về vụ mất tích",
    emotion: "cảnh giác",
    attitude: "bắt buộc phải xuống xem ngay",
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
    summary: "người chơi đã gắn chặt Tháp chuông với vụ mất tích rồi",
    belief: "tầng hầm Tháp chuông chắc chắn còn có bí mật sâu hơn",
    emotion: "căng thẳng",
    attitude: "hy vọng Ailin thúc đẩy một cách thận trọng",
  },
};

const recalledSynopsis = {
  id: "synopsis-1",
  type: "synopsis",
  scope: {
    layer: "objective",
  },
  fields: {
    summary: "Sau xung đột đêm qua, Ailin đã quay lại Tháp chuông vào sáng sớm ngày thứ hai và phát hiện lối vào dưới đất có liên hệ trực tiếp với vụ mất tích.",
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
  text: "Ailin vừa đứng vững lại trong Tháp chuông, đồng thời xác nhận lối vào dưới đất có liên hệ trực tiếp với vụ mất tích, khiến cục diện chuyển từ điều tra sang chuẩn bị tiến xuống sâu hơn.",
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
assert.match(text, /không đồng nghĩa vớiNhân vậtđã biếtsự thật/);
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

