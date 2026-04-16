import assert from "node:assert/strict";

import { createEmptyGraph, createNode } from "../graph/graph.js";
import {
  applyBatchStoryTime,
  classifyStoryTemporalBucket,
  clearManualActiveStorySegment,
  deriveStoryTimeSpanFromNodes,
  resolveActiveStoryContext,
  setManualActiveStorySegment,
  upsertTimelineSegment,
} from "../graph/story-timeline.js";

const graph = createEmptyGraph();

const night = upsertTimelineSegment(
  graph,
  { label: "Xung đột đêm qua", relation: "same", confidence: "high" },
  { source: "extract" },
);
assert.equal(night.created, true);
assert.equal(graph.timelineState.segments.length, 1);

const morningBatch = applyBatchStoryTime(
  graph,
  {
    label: "Sáng sớm ngày thứ hai",
    relation: "after",
    confidence: "high",
    tense: "ongoing",
    advancesActiveTimeline: true,
  },
  "extract",
);
assert.equal(morningBatch.ok, true);
assert.equal(morningBatch.timelineAdvanceApplied, true);
assert.equal(graph.historyState.activeStoryTimeLabel, "Sáng sớm ngày thứ hai");
assert.equal(graph.historyState.lastExtractedStorySegmentId, morningBatch.extractedSegmentId);

const future = upsertTimelineSegment(
  graph,
  {
    label: "Đêm mai",
    relation: "after",
    confidence: "medium",
    tense: "future",
  },
  { referenceSegmentId: morningBatch.extractedSegmentId, source: "extract" },
);
assert.equal(graph.timelineState.segments.length, 3);

const currentNode = createNode({
  type: "event",
  fields: { title: "hiện tạiSự kiện" },
  seq: 10,
});
currentNode.storyTime = {
  segmentId: morningBatch.extractedSegmentId,
  label: "Sáng sớm ngày thứ hai",
  tense: "ongoing",
  relation: "same",
  anchorLabel: "",
  confidence: "high",
  source: "extract",
};
const flashbackNode = createNode({
  type: "event",
  fields: { title: "Ký ức cũ" },
  seq: 8,
});
flashbackNode.storyTime = {
  segmentId: night.storyTime.segmentId,
  label: "Xung đột đêm qua",
  tense: "flashback",
  relation: "before",
  anchorLabel: "",
  confidence: "high",
  source: "extract",
};
const futureNode = createNode({
  type: "event",
  fields: { title: "kế hoạch tương lai" },
  seq: 12,
});
futureNode.storyTime = future.storyTime;

const currentBucket = classifyStoryTemporalBucket(graph, currentNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
});
assert.equal(currentBucket.bucket, "current");
assert.equal(currentBucket.suppressed, false);

const flashbackBucket = classifyStoryTemporalBucket(graph, flashbackNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
  cueMode: "flashback",
});
assert.equal(flashbackBucket.bucket, "flashback");
assert.equal(flashbackBucket.rescued, true);

const futureBucket = classifyStoryTemporalBucket(graph, futureNode, {
  activeSegmentId: morningBatch.extractedSegmentId,
});
assert.equal(futureBucket.bucket, "future");
assert.equal(futureBucket.suppressed, true);

const span = deriveStoryTimeSpanFromNodes(graph, [flashbackNode, currentNode], "derived");
assert.equal(span.startLabel, "Xung đột đêm qua");
assert.equal(span.endLabel, "Sáng sớm ngày thứ hai");
assert.equal(span.mixed, true);

const manualResult = setManualActiveStorySegment(graph, { label: "Xung đột đêm qua" });
assert.equal(manualResult.ok, true);
assert.equal(resolveActiveStoryContext(graph).activeStoryTimeLabel, "Xung đột đêm qua");

const cleared = clearManualActiveStorySegment(graph);
assert.equal(cleared.ok, true);
assert.equal(resolveActiveStoryContext(graph).activeStoryTimeLabel, "Sáng sớm ngày thứ hai");

console.log("story-timeline tests passed");

