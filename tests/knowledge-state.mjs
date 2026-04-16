import assert from "node:assert/strict";

import { createEmptyGraph, createNode, addNode } from "../graph/graph.js";
import {
  applyCognitionUpdates,
  applyManualKnowledgeOverride,
  clearManualKnowledgeOverride,
  applyRegionUpdates,
  computeKnowledgeGateForNode,
  listKnowledgeOwners,
  resolveActiveRegionContext,
  resolveAdjacentRegions,
  resolveKnowledgeOwner,
  setManualActiveRegion,
} from "../graph/knowledge-state.js";

globalThis.SillyTavern = {
  getContext() {
    return {
      name1: "Lucia",
    };
  },
};

const graph = createEmptyGraph();
const erinA = createNode({
  type: "character",
  fields: { name: "Ailin", state: "người canh tháp" },
  seq: 1,
});
const erinB = createNode({
  type: "character",
  fields: { name: "Ailin", state: "kẻ ngụy trang" },
  seq: 2,
});
const lucia = createNode({
  type: "character",
  fields: { name: "Lucia", state: "người đứng ngoài quan sát" },
  seq: 2,
});
const bellEvent = createNode({
  type: "event",
  fields: { title: "Âm thanh lạ ở Tháp chuông", summary: "Tháp chuông phát ra âm thanh lạ vào đêm khuya" },
  seq: 3,
  scope: { layer: "objective", regionPrimary: "Tháp chuông" },
});
addNode(graph, erinA);
addNode(graph, erinB);
addNode(graph, lucia);
addNode(graph, bellEvent);

const ownerA = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "Ailin",
  nodeId: erinA.id,
});
const ownerB = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "Ailin",
  nodeId: erinB.id,
});
assert.notEqual(ownerA.ownerKey, ownerB.ownerKey);

applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "character",
      ownerName: "Ailin",
      ownerNodeId: erinA.id,
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 1 }],
    },
  ],
  {
    changedNodeIds: [bellEvent.id],
    scopeRuntime: {
      activeCharacterOwner: "Ailin",
      activeUserOwner: "người chơi",
    },
  },
);

const gateVisible = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateVisible.visible, true);
assert.equal(gateVisible.anchored, true);

applyManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
  mode: "mistaken",
});
const gateSuppressed = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateSuppressed.visible, false);
assert.equal(gateSuppressed.suppressedReason, "mistaken-objective");

const clearedOverride = clearManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
});
assert.equal(clearedOverride.ok, true);
const gateRestored = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateRestored.visible, true);
assert.notEqual(gateRestored.suppressedReason, "mistaken-objective");

applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "character",
      ownerName: "Lucia",
      ownerNodeId: lucia.id,
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 1 }],
    },
  ],
  { changedNodeIds: [bellEvent.id] },
);
applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "user",
      ownerName: "Lucia",
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 0.8 }],
    },
  ],
  { changedNodeIds: [bellEvent.id] },
);
applyManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
  mode: "mistaken",
});
const gateUnion = computeKnowledgeGateForNode(
  graph,
  bellEvent,
  [ownerA.ownerKey, `character:Lucia`],
  {
    scopeBucket: "objectiveCurrentRegion",
  },
);
assert.equal(gateUnion.visible, true);
assert.deepEqual(gateUnion.visibleOwnerKeys, ["character:Lucia"]);
assert.deepEqual(gateUnion.suppressedOwnerKeys, [ownerA.ownerKey]);

applyRegionUpdates(graph, {
  activeRegionHint: "Tháp chuông",
  adjacency: [{ region: "Tháp chuông", adjacent: ["Khu phố cũ", "Nội đình"] }],
});
assert.equal(resolveActiveRegionContext(graph).activeRegion, "Tháp chuông");
assert.deepEqual(resolveAdjacentRegions(graph, "Tháp chuông").adjacentRegions, ["Khu phố cũ", "Nội đình"]);

setManualActiveRegion(graph, "Khu phố cũ");
assert.equal(resolveActiveRegionContext(graph).source, "manual");
assert.equal(resolveActiveRegionContext(graph).activeRegion, "Khu phố cũ");

const ownerList = listKnowledgeOwners(graph);
assert.ok(ownerList.some((entry) => entry.ownerKey === ownerA.ownerKey));
assert.ok(
  ownerList.some(
    (entry) => entry.ownerName === "Lucia" && entry.knownCount >= 1,
  ),
);
const sameNameOwners = ownerList.filter((entry) => entry.ownerName === "Lucia");
assert.equal(sameNameOwners.length, 2);
assert.deepEqual(
  sameNameOwners.map((entry) => entry.ownerType).sort(),
  ["character", "user"],
);

const aliasMatchedUserOwner = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "Lucia",
});
assert.equal(aliasMatchedUserOwner.ownerType, "user");
assert.equal(aliasMatchedUserOwner.ownerName, "Lucia");

const syntheticGraph = createEmptyGraph();
syntheticGraph.historyState.activeUserPovOwner = "người chơi";
addNode(
  syntheticGraph,
  createNode({
    type: "character",
    fields: { name: "Người chơi" },
    seq: 1,
  }),
);
const syntheticOwners = listKnowledgeOwners(syntheticGraph);
assert.equal(syntheticOwners.some((entry) => entry.ownerType === "character"), false);

const roleCardGraph = createEmptyGraph();
const roleCardEvent = createNode({
  type: "event",
  fields: { title: "Thời tiết thay đổi", summary: "Bên ngoài cửa sổ đã bắt đầu mưa" },
  seq: 1,
});
addNode(roleCardGraph, roleCardEvent);
applyCognitionUpdates(
  roleCardGraph,
  [],
  {
    changedNodeIds: [roleCardEvent.id],
    scopeRuntime: {
      activeCharacterOwner: "thẻ dẫn truyện",
      activeUserOwner: "người chơi",
    },
  },
);
const roleCardOwners = listKnowledgeOwners(roleCardGraph);
assert.equal(
  roleCardOwners.some(
    (entry) =>
      entry.ownerType === "character" && entry.ownerName === "thẻ dẫn truyện",
  ),
  false,
);

const characterNodeGraph = createEmptyGraph();
const plainCharacterNode = createNode({
  type: "character",
  fields: { name: "thẻ dẫn truyện", state: "chỉ là thực thể thẻ nhân vật" },
  seq: 1,
});
addNode(characterNodeGraph, plainCharacterNode);
applyCognitionUpdates(
  characterNodeGraph,
  [],
  {
    changedNodeIds: [plainCharacterNode.id],
    scopeRuntime: {
      activeCharacterOwner: "thẻ dẫn truyện",
      activeUserOwner: "người chơi",
    },
  },
);
const characterNodeOwners = listKnowledgeOwners(characterNodeGraph);
assert.equal(
  characterNodeOwners.some(
    (entry) =>
      entry.ownerType === "character" && entry.ownerName === "thẻ dẫn truyện",
  ),
  false,
);

const duplicateCharacterGraph = createEmptyGraph();
const roleCardNameNode = createNode({
  type: "character",
  fields: { name: "Ailin" },
  seq: 1,
});
const watchedEvent = createNode({
  type: "event",
  fields: { title: "Nhìn thấy Tháp chuông", summary: "" },
  seq: 2,
});
addNode(duplicateCharacterGraph, roleCardNameNode);
addNode(duplicateCharacterGraph, watchedEvent);
applyCognitionUpdates(
  duplicateCharacterGraph,
  [
    {
      ownerType: "character",
      ownerName: "Ailin",
      knownRefs: [watchedEvent.id],
      visibility: [{ ref: watchedEvent.id, score: 0.9 }],
    },
  ],
  { changedNodeIds: [watchedEvent.id] },
);
const dedupedCharacterOwners = listKnowledgeOwners(duplicateCharacterGraph).filter(
  (entry) => entry.ownerType === "character",
);
assert.equal(dedupedCharacterOwners.length, 1);
assert.equal(dedupedCharacterOwners[0].knownCount >= 1, true);
assert.equal(
  dedupedCharacterOwners[0].ownerName,
  "Ailin",
);
assert.equal(
  dedupedCharacterOwners[0].aliases.includes("Ailin"),
  true,
);

console.log("knowledge-state tests passed");


