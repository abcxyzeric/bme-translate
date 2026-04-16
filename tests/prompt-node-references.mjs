import assert from "node:assert/strict";

const {
  createPromptNodeReferenceMap,
  getPromptNodeLabel,
  resolvePromptNodeId,
} = await import("../prompting/prompt-node-references.js");

const rawNodeId = "550e8400-e29b-41d4-a716-446655440000";
const map = createPromptNodeReferenceMap(
  [
    {
      nodeId: rawNodeId,
      node: {
        id: rawNodeId,
        type: "event",
        fields: {
          title: "Đây là một tiêu đề nút rất rất dài, dùng để kiểm thử hành vi cắt ngắn nhãn trong nhắc trích xuất",
        },
      },
      score: 0.91,
    },
    {
      node: {
        id: "node-2",
        type: "thread",
        fields: {
          summary: "quan hệ tiếp tục ấm lên",
        },
      },
      score: 0.77,
    },
  ],
  {
    prefix: "G",
    maxLength: 12,
    buildMeta: ({ entry }) => ({
      score: entry.score,
    }),
  },
);

assert.deepEqual(Object.keys(map.keyToNodeId), ["G1", "G2"]);
assert.equal(map.keyToNodeId.G1, rawNodeId);
assert.equal(map.nodeIdToKey[rawNodeId], "G1");
assert.equal(resolvePromptNodeId({ nodeId: rawNodeId }), rawNodeId);
assert.equal(resolvePromptNodeId({ node: { id: "node-2" } }), "node-2");
assert.equal(getPromptNodeLabel({ id: "node-3", fields: { title: "Tiêu đề ngắn" } }), "Tiêu đề ngắn");
assert.equal(map.keyToMeta.G1.score, 0.91);
assert.match(map.keyToMeta.G1.label, /^Đây là một tiêu đề nút rất…$/);
assert.equal(map.keyToMeta.G2.label, "quan hệ tiếp tục ấm lên");
assert.equal(map.keyToMeta.G1.nodeId, rawNodeId);

console.log("prompt-node-references tests passed");

