import assert from "node:assert/strict";

import {
  appendMaintenanceJournal,
  createMaintenanceJournalEntry,
  normalizeGraphRuntimeState,
  undoLatestMaintenance,
} from "../runtime/runtime-state.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildNode(id, extra = {}) {
  return {
    id,
    type: "character",
    archived: false,
    seq: 1,
    seqRange: [1, 1],
    importance: 5,
    fields: {},
    childIds: [],
    parentId: null,
    prevId: null,
    nextId: null,
    ...extra,
  };
}

function buildEdge(id, fromId, toId, extra = {}) {
  return {
    id,
    fromId,
    toId,
    relation: "related",
    strength: 1,
    ...extra,
  };
}

{
  const before = {
    nodes: [buildNode("sleep-1")],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;

  const graph = normalizeGraphRuntimeState(clone(after), "chat-sleep");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "sleep",
    mode: "manual",
    summary: "Thủ côngLãng quên：Lưu trữ 1  nút",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(graph.nodes[0].archived, false);
  assert.equal(graph.maintenanceJournal.length, 0);
}

{
  const before = {
    nodes: [
      buildNode("child-1"),
      buildNode("child-2"),
      buildNode("location-1", { type: "location", fields: { title: "đại sảnh" } }),
    ],
    edges: [buildEdge("edge-old", "child-1", "location-1")],
  };
  const after = clone(before);
  after.nodes[0].archived = true;
  after.nodes[0].parentId = "parent-1";
  after.nodes[1].archived = true;
  after.nodes[1].parentId = "parent-1";
  after.nodes.push(
    buildNode("parent-1", {
      level: 1,
      fields: { summary: "nút cha nén" },
      childIds: ["child-1", "child-2"],
    }),
  );
  after.edges.push(buildEdge("edge-new", "parent-1", "location-1"));

  const graph = normalizeGraphRuntimeState(clone(after), "chat-compress");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "compress",
    mode: "manual",
    summary: "Nén thủ công：Tạo mới 1，Lưu trữ 2",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(graph.nodes.some((node) => node.id === "parent-1"), false);
  assert.equal(
    graph.edges.some((edge) => edge.id === "edge-new"),
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "child-1")?.archived,
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "child-2")?.archived,
    false,
  );
}

{
  const before = {
    nodes: [
      buildNode("new-1", { fields: { summary: "manh mối mới" } }),
      buildNode("old-1", { fields: { summary: "mô tả cũ" } }),
    ],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;
  after.nodes[1].fields.summary = "";
  after.edges.push(buildEdge("edge-merge", "new-1", "old-1"));

  const graph = normalizeGraphRuntimeState(clone(after), "chat-consolidate");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "consolidate",
    mode: "manual",
    summary: "Thủ côngHợp nhất：Hợp nhất 1, cập nhật 1",
  });

  appendMaintenanceJournal(graph, entry);
  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, true);
  assert.equal(
    graph.nodes.find((node) => node.id === "new-1")?.archived,
    false,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "old-1")?.fields?.summary,
    "mô tả cũ",
  );
  assert.equal(
    graph.edges.some((edge) => edge.id === "edge-merge"),
    false,
  );
}

{
  const before = {
    nodes: [buildNode("sleep-2")],
    edges: [],
  };
  const after = clone(before);
  after.nodes[0].archived = true;

  const graph = normalizeGraphRuntimeState(clone(after), "chat-diverged");
  const entry = createMaintenanceJournalEntry(before, after, {
    action: "sleep",
    mode: "manual",
    summary: "Thủ côngLãng quên：Lưu trữ 1  nút",
  });

  appendMaintenanceJournal(graph, entry);
  graph.nodes[0].importance = 9;

  const result = undoLatestMaintenance(graph);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Trạng thái hiện tại đã thay đổi|đã bị thao tác về sau ghi đè/);
  assert.equal(graph.maintenanceJournal.length, 1);
}

console.log("maintenance-journal tests passed");


