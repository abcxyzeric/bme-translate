import assert from "node:assert/strict";

import { MODULE_NAME } from "../graph/graph-persistence.js";
import {
  buildRecallRecentMessagesController,
  resolveRecallInputController,
} from "../retrieval/recall-controller.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

async function testSendIntentCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "cũ chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "đầu vào mới vừa kích hoạt gửi",
    hash: "hash-phase4-send-intent",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "đầu vào mới vừa kích hoạt gửi");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, 0);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "đầu vào mới vừa kích hoạt gửi",
  );
  assert.equal(transaction.frozenRecallOptions.lockedSource, "send-intent");
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, 0);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "cũ chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testPlannerHandoffCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "đầu vào người dùng ổn định trong tầng" }];

  const handoff = harness.result.preparePlannerRecallHandoff({
    rawUserInput: "planner nguyên gốcđầu vào",
    plannerAugmentedMessage: "đầu vào sau khi được planner tăng cường",
    plannerRecall: {
      memoryBlock: "khối ký ức quy hoạch",
      recentMessages: ["[user]: planner nguyên gốcđầu vào", "[assistant]: Ký ứckhớp trúng"],
      result: {
        selectedNodeIds: ["node-planner-1"],
        stats: {
          coreCount: 1,
          recallCount: 1,
        },
        meta: {
          retrieval: {
            vectorHits: 1,
            vectorMergedHits: 0,
            diffusionHits: 0,
            candidatePoolAfterDpp: 1,
            llm: {
              status: "disabled",
              candidatePool: 0,
            },
          },
        },
      },
    },
    chatId: "chat-main",
  });

  assert.ok(handoff);

  const recallContext = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: {},
    chatId: "chat-main",
  });

  assert.equal(recallContext.shouldRun, true);
  assert.equal(recallContext.recallOptions.overrideUserMessage, "planner nguyên gốcđầu vào");
  assert.equal(recallContext.recallOptions.overrideSource, "planner-handoff");
  assert.equal(recallContext.recallOptions.authoritativeInputUsed, true);
  assert.equal(
    recallContext.recallOptions.boundUserFloorText,
    "đầu vào người dùng ổn định trong tầng",
  );
  assert.equal(recallContext.recallOptions.includeSyntheticUserMessage, true);
  assert.ok(recallContext.recallOptions.cachedRecallPayload);
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload.source,
    "planner-handoff",
  );

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "planner nguyên gốcđầu vào");
  assert.equal(harness.runRecallCalls[0].overrideSource, "planner-handoff");
  assert.equal(harness.runRecallCalls[0].authoritativeInputUsed, true);
  assert.equal(
    harness.runRecallCalls[0].boundUserFloorText,
    "đầu vào người dùng ổn định trong tầng",
  );
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);
  assert.ok(harness.runRecallCalls[0].cachedRecallPayload);
}

async function testAuthoritativeSendIntentStaysFrozenAcrossHooksWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "ổn định chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "thứ nhấtlầnĐầu vào chuẩn quyền",
    hash: "hash-phase4-frozen-a",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  harness.pendingRecallSendIntent = {
    text: "đầu vào trôi lệch ở lần thứ hai",
    hash: "hash-phase4-frozen-b",
    at: Date.now(),
    source: "dom-intent",
  };
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "thứ nhấtlầnĐầu vào chuẩn quyền");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].authoritativeInputUsed, true);
  assert.equal(harness.runRecallCalls[0].boundUserFloorText, "ổn định chat tail");

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "thứ nhấtlầnĐầu vào chuẩn quyền",
  );
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "ổn định chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testHostSnapshotCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "cũ chat tail" }];
  const frozenSnapshot = harness.result.freezeHostGenerationInputSnapshot(
    "Hostsnapshotđầu vào",
  );

  await harness.result.onGenerationAfterCommands(
    "normal",
    { frozenInputSnapshot: frozenSnapshot },
    false,
  );

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "Hostsnapshotđầu vào");
  assert.equal(
    harness.runRecallCalls[0].overrideSource,
    "host-generation-lifecycle",
  );
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, 0);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);
  assert.equal(
    JSON.stringify(
      harness.runRecallCalls[0].sourceCandidates.map((candidate) => candidate.source),
    ),
    JSON.stringify(["host-generation-lifecycle", "chat-tail-user"]),
  );

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(transaction.frozenRecallOptions.overrideUserMessage, "Hostsnapshotđầu vào");
  assert.equal(
    transaction.frozenRecallOptions.lockedSource,
    "host-generation-lifecycle",
  );
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, 0);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "cũ chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testGenerationAfterCommandsWritesBackAuthoritativePromptWhenPreserved() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "cũ chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "trước khi gửiĐầu vào chuẩn quyền",
    hash: "hash-phase4-writeback",
    at: Date.now(),
    source: "dom-intent",
  };
  const params = {
    prompt: "prompt cũ",
    user_input: "user_input cũ",
  };

  await harness.result.onGenerationAfterCommands("normal", params, false);

  assert.equal(params.prompt, "trước khi gửiĐầu vào chuẩn quyền");
  assert.equal(params.user_input, "trước khi gửiĐầu vào chuẩn quyền");
}

function testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage() {
  const runtime = {
    normalizeRecallInputText(value = "") {
      return String(value || "").trim();
    },
    buildRecallRecentMessages(chat, limit, syntheticUserMessage = "") {
      return buildRecallRecentMessagesController(chat, limit, syntheticUserMessage, {
        formatRecallContextLine(message) {
          return `[${message?.is_user ? "user" : "assistant"}]: ${String(message?.mes || "")}`;
        },
        normalizeRecallInputText(value = "") {
          return String(value || "").trim();
        },
      });
    },
  };
  const result = resolveRecallInputController(
    [{ is_user: true, mes: "cũ chat tail" }],
    4,
    {
      overrideUserMessage: "Đầu vào chuẩn quyền",
      overrideSource: "send-intent",
      includeSyntheticUserMessage: true,
    },
    runtime,
  );

  assert.equal(result.userMessage, "Đầu vào chuẩn quyền");
  assert.equal(result.source, "send-intent");
  assert.equal(result.authoritativeInputUsed, false);
  assert.equal(result.boundUserFloorText, "");
  assert.deepEqual(result.recentMessages, [
    "[user]: cũ chat tail",
    "[user]: Đầu vào chuẩn quyền",
  ]);
}

await testSendIntentCanRemainAuthoritativeQueryWhenFlagEnabled();
await testPlannerHandoffCanRemainAuthoritativeQueryWhenFlagEnabled();
await testAuthoritativeSendIntentStaysFrozenAcrossHooksWhenFlagEnabled();
await testHostSnapshotCanRemainAuthoritativeQueryWhenFlagEnabled();
await testGenerationAfterCommandsWritesBackAuthoritativePromptWhenPreserved();
testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage();

console.log("recall-authoritative-generation-input tests passed");

