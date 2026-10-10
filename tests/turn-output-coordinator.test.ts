import { describe, expect, test, vi } from 'vitest';

import {
  ActiveTurnOutputRegistry,
  TurnOutputCoordinator,
} from '../src/turn-output-coordinator.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';

describe('TurnOutputCoordinator answer lanes', () => {
  test('removes streamed process narration when the same assistant response later calls a tool', () => {
    const coordinator = new TurnOutputCoordinator();

    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-1',
    });
    expect(
      coordinator.reduceStreamEvent({
        eventType: 'text_delta',
        text: '我先查一下这个链接。',
        messageUuid: 'assistant-1',
      }),
    ).toMatchObject({
      answerText: '',
      visibleAnswerText: '我先查一下这个链接。',
      visibleAnswerChanged: true,
      provisionalText: '我先查一下这个链接。',
      answerChanged: false,
      narrationDiscarded: false,
    });

    const rolledBack = coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'WebFetch',
      messageUuid: 'assistant-1',
    });
    expect(rolledBack).toMatchObject({
      answerText: '',
      visibleAnswerText: '',
      visibleAnswerChanged: true,
    });
    expect(
      coordinator.reduceStreamEvent({
        eventType: 'raw_sdk_event',
        rawType: 'stream_event/message_stop',
        messageUuid: 'assistant-1',
      }),
    ).toMatchObject({
      answerText: '',
      answerChanged: false,
      visibleAnswerText: '',
      narrationDiscarded: true,
    });
    expect(coordinator.lastNarration).toBe('我先查一下这个链接。');

    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-2',
    });
    const firstFinalDelta = coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '# 调研结论\n\n',
      messageUuid: 'assistant-2',
    });
    expect(firstFinalDelta).toMatchObject({
      answerText: '',
      visibleAnswerText: '# 调研结论\n\n',
      visibleAnswerChanged: true,
    });
    const secondFinalDelta = coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '最终报告',
      messageUuid: 'assistant-2',
    });
    expect(secondFinalDelta.visibleAnswerText).toBe('# 调研结论\n\n最终报告');
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-2',
    });
    expect(coordinator.candidateText).toBe('# 调研结论\n\n最终报告');
  });

  test('tool_use followed by text in the same assistant message is still narration', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-tool-first',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Task',
      messageUuid: 'assistant-tool-first',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '任务已经派出，正在等待。',
      messageUuid: 'assistant-tool-first',
    });
    const projection = coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-tool-first',
    });

    expect(projection.answerText).toBe('');
    expect(projection.narrationDiscarded).toBe(true);
    expect(coordinator.lastNarration).toBe('任务已经派出，正在等待。');
  });

  test('sub-agent text and nested tools never mutate the primary answer lane', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主 Agent 答案',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '子 Agent 过程输出',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Read',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'main-1',
    });
    expect(coordinator.candidateText).toBe('主 Agent 答案');
  });

  test('nested assistant boundaries cannot replace an in-flight primary message', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主答案前半段，',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '子 Agent 过程',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Read',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'nested-1',
      parentToolUseId: 'task-1',
    });
    expect(coordinator.visibleAnswerText).toBe('主答案前半段，');

    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: '主答案后半段。',
      messageUuid: 'main-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'main-1',
    });

    expect(coordinator.candidateText).toBe('主答案前半段，主答案后半段。');
  });

  test('always treats non-empty SDK Result.success.result as authoritative', () => {
    const coordinator = new TurnOutputCoordinator();
    const narration = '三个调研任务已派出，等待完成。';
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-1',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: narration,
    });
    coordinator.reduceStreamEvent({
      eventType: 'tool_use_start',
      toolName: 'Task',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-1',
    });

    expect(coordinator.resolvePrimaryAnswer(narration)).toEqual({
      text: narration,
      source: 'sdk_final',
    });
  });

  test('SDK final owns the primary answer even when MCP final was staged first', () => {
    const coordinator = new TurnOutputCoordinator();
    expect(coordinator.stageMessage('final', 'MCP 候选答案').accepted).toBe(
      true,
    );
    expect(coordinator.resolvePrimaryAnswer('SDK 权威答案')).toEqual({
      text: 'SDK 权威答案',
      source: 'sdk_final',
    });
  });

  test('staged MCP final is the fallback when SDK result is empty', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.stageMessage('final', '工具生成的完整报告');
    expect(coordinator.resolvePrimaryAnswer(null)).toEqual({
      text: '工具生成的完整报告',
      source: 'mcp_final',
    });
  });
});

describe('ActiveTurnOutputRegistry exactly-one staging', () => {
  test('progress and final update one active projection without creating sibling sends', () => {
    const registry = new ActiveTurnOutputRegistry();
    const progress = vi.fn(() => true);
    const final = vi.fn(() => true);
    registry.bind('workspace:main', 'turn-1', {
      onProgress: progress,
      onFinalCandidate: final,
    });

    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'progress',
        text: '正在抓取资料',
      }),
    ).toEqual({ accepted: true, duplicate: false });
    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'final',
        text: '完整报告',
      }),
    ).toEqual({ accepted: true, duplicate: false });
    expect(progress).toHaveBeenCalledOnce();
    expect(final).toHaveBeenCalledOnce();
  });

  test('replayed staged output is acknowledged but not projected twice', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi.fn(() => true);
    registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    const input = {
      scopeKey: 'workspace:main',
      inputTurnId: 'turn-1',
      role: 'final' as const,
      text: '同一份报告',
    };

    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(final).toHaveBeenCalledOnce();
  });

  test('late MCP final is rejected after SDK final owns the answer', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi.fn(() => true);
    const coordinator = registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    coordinator.resolvePrimaryAnswer('SDK final');
    coordinator.markFinalized();

    expect(
      registry.stage({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        role: 'final',
        text: 'late tool final',
      }),
    ).toEqual({
      accepted: false,
      duplicate: false,
      reason: 'finalized',
    });
    expect(final).not.toHaveBeenCalled();
  });

  test('main and conversation-agent scopes stay isolated for the same input ID', () => {
    const registry = new ActiveTurnOutputRegistry();
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    const mainScope = channelTurnScope('workspace');
    const agentScope = channelTurnScope('workspace', 'custom-agent');
    registry.bind(mainScope, 'same-turn', {
      onProgress: a,
      onFinalCandidate: a,
    });
    registry.bind(agentScope, 'same-turn', {
      onProgress: b,
      onFinalCandidate: b,
    });

    registry.stage({
      scopeKey: agentScope,
      inputTurnId: 'same-turn',
      role: 'progress',
      text: 'custom agent progress',
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  test('records physical utterances only for the exact active scope and input', () => {
    const registry = new ActiveTurnOutputRegistry();
    const mainDelivered = vi.fn();
    const agentDelivered = vi.fn();
    const mainScope = channelTurnScope('workspace');
    const agentScope = channelTurnScope('workspace', 'conversation-agent');
    const main = registry.bind(mainScope, 'same-turn', {
      onProgress: () => true,
      onFinalCandidate: () => true,
      onUtteranceDelivered: mainDelivered,
    });
    const agent = registry.bind(agentScope, 'same-turn', {
      onProgress: () => true,
      onFinalCandidate: () => true,
      onUtteranceDelivered: agentDelivered,
    });

    expect(
      registry.recordDeliveredUtterance({
        scopeKey: agentScope,
        inputTurnId: 'same-turn',
      }),
    ).toBe(true);
    expect(main.deliveredUtterances).toBe(0);
    expect(agent.deliveredUtterances).toBe(1);
    expect(mainDelivered).not.toHaveBeenCalled();
    expect(agentDelivered).toHaveBeenCalledOnce();

    agent.markFinalized();
    expect(
      registry.recordDeliveredUtterance({
        scopeKey: agentScope,
        inputTurnId: 'same-turn',
      }),
    ).toBe(false);
    expect(agent.deliveredUtterances).toBe(1);
    expect(agentDelivered).toHaveBeenCalledOnce();
  });

  test('projection failure does not poison dedupe or staged-final state', () => {
    const registry = new ActiveTurnOutputRegistry();
    const final = vi
      .fn<(_: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const coordinator = registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: final,
    });
    const input = {
      scopeKey: 'workspace:main',
      inputTurnId: 'turn-1',
      role: 'final' as const,
      text: '不能静默丢失',
    };

    expect(registry.stage(input)).toEqual({
      accepted: false,
      duplicate: false,
      reason: 'projection_unavailable',
    });
    expect(coordinator.resolvePrimaryAnswer(null)).toEqual({
      text: null,
      source: 'empty',
    });
    expect(registry.stage(input)).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(final).toHaveBeenCalledTimes(2);
  });
});

describe('Proactive final delivery recovery', () => {
  test('recovers a non-empty SDK final after only progress was delivered', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: '我先检查现有技能，稍等。',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery('这是完整的 Agent 草稿预览。'),
    ).toEqual({
      deliver: true,
      text: '这是完整的 Agent 草稿预览。',
      reason: 'missing_final_delivery',
    });
  });

  test('does not duplicate an explicitly delivered final utterance', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'final',
      text: '完整报告已经发送。',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery('内部 SDK 收尾文本'),
    ).toEqual({
      deliver: false,
      text: '内部 SDK 收尾文本',
      reason: 'explicit_final_delivered',
    });
  });

  test('an attempted explicit final stays authoritative over a lying SDK closure', () => {
    const coordinator = new TurnOutputCoordinator();
    expect(
      coordinator.recordAttemptedFinal(
        '# 完整总结\n\n这是用户真正需要看到的正文。',
      ),
    ).toBe(true);

    expect(
      coordinator.resolveProactiveFinalRecovery(
        '已通过 send_message(final) 投递完整总结。本轮工作已完成。',
      ),
    ).toEqual({
      deliver: false,
      text: '# 完整总结\n\n这是用户真正需要看到的正文。',
      reason: 'explicit_final_attempted',
    });
    expect(coordinator.deliveredUtterances).toBe(0);
  });

  test('does not let a later final replace the first uncertain attempt', () => {
    const coordinator = new TurnOutputCoordinator();
    expect(coordinator.recordAttemptedFinal('第一份 final')).toBe(true);
    expect(coordinator.recordAttemptedFinal('第二份 final')).toBe(false);
    expect(coordinator.attemptedFinalText).toBe('第一份 final');
  });

  test('deduplicates the exact delivered text even when an older caller omitted the final role', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: '  完整报告\r\n第二行  ',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery('完整报告\n第二行'),
    ).toEqual({
      deliver: false,
      text: '完整报告\n第二行',
      reason: 'duplicate_delivery',
    });
  });

  test('suppresses a short SDK courtesy closure after a complete answer was mislabeled as progress', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: [
        '草稿已经做好了，上一条消息里有完整预览，现在卡在等你确认。',
        '一句话回顾：调研 Agent 会并行调研并汇总成飞书文档，已经精确选择了所需技能。',
        '两个前置提醒仍然有效，发布时请回复确认口令；要修改哪里也可以直接说。',
      ].join('\n\n'),
    });

    expect(
      coordinator.resolveProactiveFinalRecovery(
        '草稿就绪，等你确认口令或修改意见。',
      ),
    ).toEqual({
      deliver: false,
      text: '草稿就绪，等你确认口令或修改意见。',
      reason: 'redundant_sdk_closure',
    });
  });

  test('keeps concise SDK finals that add a root cause, identifier, or structured payload', () => {
    for (const candidate of [
      '调查完成，根因是权限不足，需要重新授权。',
      '发布完成，ID：AGENT-12345',
      '报告已就绪：https://example.com/report',
      '下一步：运行 `feishu-cli auth login`。',
      '文档已就绪，下载地址为 report.internal/doc',
      '草稿完成，请回复确认口令 AGENT_READY',
      '报告完成，所有临时文件已删除。',
    ]) {
      const coordinator = new TurnOutputCoordinator();
      coordinator.recordDeliveredUtterance({
        role: 'progress',
        text: '排查已经完成，完整过程和现象都整理好了。目前正在确认最终根因和对应处理方式，稍后给出最后结论。',
      });

      expect(
        coordinator.resolveProactiveFinalRecovery(candidate),
      ).toMatchObject({
        deliver: true,
        text: candidate,
        reason: 'missing_final_delivery',
      });
    }
  });

  test('keeps a completion message when earlier progress was only an interim update', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: '我正在抓取全部资料并逐项核对来源，目前已经处理一半。接下来还要验证关键事实、整理引用并生成最终报告，请稍等。',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery('报告已经完成，请查收。'),
    ).toEqual({
      deliver: true,
      text: '报告已经完成，请查收。',
      reason: 'missing_final_delivery',
    });
  });

  test('does not mistake started generation for a completed progress answer', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: '我已经开始生成最终报告，目前正在整理引用和检查关键数据。完整文档还没有完成，接下来需要继续验证来源并补充结论。',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery('报告已经完成，请查收。'),
    ).toEqual({
      deliver: true,
      text: '报告已经完成，请查收。',
      reason: 'missing_final_delivery',
    });
  });

  test('suppresses an English courtesy closure after a complete progress answer', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.recordDeliveredUtterance({
      role: 'progress',
      text: 'The draft is already completed and the full preview is above. The final result, required skills, confirmation phrase, and next actions are all included in that message.',
    });

    expect(
      coordinator.resolveProactiveFinalRecovery(
        'Draft ready. Let me know if you want changes.',
      ),
    ).toEqual({
      deliver: false,
      text: 'Draft ready. Let me know if you want changes.',
      reason: 'redundant_sdk_closure',
    });
  });

  test('recovers direct SDK answers when the model never called send_message', () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind('workspace:main', 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });

    expect(
      registry.resolveProactiveFinalRecovery({
        scopeKey: 'workspace:main',
        inputTurnId: 'turn-1',
        text: '直接回答',
      }),
    ).toEqual({
      deliver: true,
      text: '直接回答',
      reason: 'missing_final_delivery',
    });
  });

  test('fails open to recovery when a healthy result outlives its process-local binding', () => {
    const registry = new ActiveTurnOutputRegistry();
    expect(
      registry.resolveProactiveFinalRecovery({
        scopeKey: 'workspace:main',
        inputTurnId: 'recovered-turn',
        text: '恢复出来的最终答案',
      }),
    ).toEqual({
      deliver: true,
      text: '恢复出来的最终答案',
      reason: 'untracked_turn',
    });
  });

  test('keeps an explicit final authoritative when IPC arrives before the warm turn binding', () => {
    const registry = new ActiveTurnOutputRegistry();
    expect(
      registry.recordAttemptedFinal({
        scopeKey: 'workspace:main',
        inputTurnId: 'restoring-turn',
        text: 'Outbox 已持久化的准确 final',
      }),
    ).toBe(true);
    expect(
      registry.resolveProactiveFinalRecovery({
        scopeKey: 'workspace:main',
        inputTurnId: 'restoring-turn',
        text: '已通过 send_message(final) 投递。本轮完成。',
      }),
    ).toEqual({
      deliver: false,
      text: 'Outbox 已持久化的准确 final',
      reason: 'explicit_final_attempted',
    });

    const coordinator = registry.bind('workspace:main', 'restoring-turn', {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });
    expect(coordinator.attemptedFinalText).toBe('Outbox 已持久化的准确 final');
  });
});
