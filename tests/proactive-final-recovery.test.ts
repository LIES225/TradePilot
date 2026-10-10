import { describe, expect, test, vi } from 'vitest';

import {
  preserveUnacknowledgedProactiveFinal,
  recoverProactiveFinalCandidate,
} from '../src/proactive-final-recovery.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';

const SCOPE = 'workspace\0conversation:agent';
const TURN = 'turn-1';
const CALLBACKS = {
  onProgress: () => true,
  onFinalCandidate: () => true,
};

describe('Proactive SDK final recovery orchestration', () => {
  test('delivers and records a final after a progress-only message', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, CALLBACKS);
    registry.recordDeliveredUtterance({
      scopeKey: SCOPE,
      inputTurnId: TURN,
      role: 'progress',
      text: '我先检查相关技能。',
    });
    const deliver = vi.fn(async () => ({
      projected: true,
      targetDelivered: true,
      path: 'web' as const,
    }));

    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '完整草稿预览',
        canDeliver: () => true,
        deliver,
      }),
    ).resolves.toEqual({
      attempted: true,
      projected: true,
      targetDelivered: true,
      path: 'web',
      reason: 'missing_final_delivery',
    });
    expect(deliver).toHaveBeenCalledWith('完整草稿预览');

    // The recovery itself is now the acknowledged final, so a late duplicate
    // terminal cannot publish a sibling message.
    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '另一个 SDK 收尾文本',
        canDeliver: () => true,
        deliver,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      reason: 'explicit_final_delivered',
    });
    expect(deliver).toHaveBeenCalledOnce();
  });

  test('suppresses exact duplicates and explicit final acknowledgements', async () => {
    for (const prior of [
      { role: 'progress' as const, text: '同一份完整答案' },
      { role: 'final' as const, text: '已经发送的最终答案' },
    ]) {
      const registry = new ActiveTurnOutputRegistry();
      registry.bind(SCOPE, TURN, CALLBACKS);
      registry.recordDeliveredUtterance({
        scopeKey: SCOPE,
        inputTurnId: TURN,
        ...prior,
      });
      const deliver = vi.fn();
      const result = await recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate:
          prior.role === 'progress' ? prior.text : '不应展示的 SDK 收尾',
        canDeliver: () => true,
        deliver,
      });

      expect(result.attempted).toBe(false);
      expect(result.reason).toBe(
        prior.role === 'progress'
          ? 'duplicate_delivery'
          : 'explicit_final_delivered',
      );
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  test('does not deliver a redundant SDK courtesy closure after a complete progress answer', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, CALLBACKS);
    registry.recordDeliveredUtterance({
      scopeKey: SCOPE,
      inputTurnId: TURN,
      role: 'progress',
      text: '草稿已经做好，完整预览、最终结论、确认口令和修改方式都在这条消息中。你可以直接回复确认口令发布，也可以告诉我需要修改的地方。',
    });
    const deliver = vi.fn();

    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '草稿就绪，等你确认口令或修改意见。',
        canDeliver: () => true,
        deliver,
      }),
    ).resolves.toEqual({
      attempted: false,
      projected: false,
      targetDelivered: false,
      reason: 'redundant_sdk_closure',
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test('does not publish incomplete results or bypass the reply fuse', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, CALLBACKS);
    const deliver = vi.fn();

    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: false,
        candidate: '后台任务仍在运行',
        canDeliver: () => true,
        deliver,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      reason: 'incomplete_turn',
    });
    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '最终答案',
        canDeliver: () => false,
        deliver,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      reason: 'reply_limit_reached',
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test('keeps a Web projection without claiming a failed native ACK', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, CALLBACKS);

    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: 'Web 中仍可恢复的答案',
        canDeliver: () => true,
        deliver: async () => ({
          projected: true,
          targetDelivered: false,
          path: 'web_after_native_failure',
        }),
      }),
    ).resolves.toEqual({
      attempted: true,
      projected: true,
      targetDelivered: false,
      path: 'web_after_native_failure',
      reason: 'missing_final_delivery',
    });
    expect(registry.get(SCOPE, TURN)?.hasDeliveredUtterance).toBe(true);
    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '重复回调不应再次广播',
        canDeliver: () => true,
        deliver: vi.fn(),
      }),
    ).resolves.toMatchObject({
      attempted: false,
      reason: 'explicit_final_delivered',
    });
  });

  test('preserves the exact uncertain final in Web and suppresses the SDK closure without claiming native ACK', async () => {
    const registry = new ActiveTurnOutputRegistry();
    const nativeDelivered = vi.fn();
    registry.bind(SCOPE, TURN, {
      ...CALLBACKS,
      onUtteranceDelivered: nativeDelivered,
    });
    registry.recordAttemptedFinal({
      scopeKey: SCOPE,
      inputTurnId: TURN,
      text: '# 完整总结\n\n四个 AI-native 工作方式',
    });
    const project = vi.fn(async () => true);

    await expect(
      preserveUnacknowledgedProactiveFinal({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        text: '# 完整总结\n\n四个 AI-native 工作方式',
        uncertain: true,
        project,
      }),
    ).resolves.toEqual({
      projected: true,
      finalizationReason: 'delivery_uncertain',
    });
    expect(project).toHaveBeenCalledWith(
      '# 完整总结\n\n四个 AI-native 工作方式',
      'delivery_uncertain',
    );
    expect(nativeDelivered).not.toHaveBeenCalled();

    const deliverFallback = vi.fn();
    await expect(
      recoverProactiveFinalCandidate({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        inputTurnCompleted: true,
        candidate: '已通过 send_message(final) 投递完整总结。本轮工作已完成。',
        canDeliver: () => true,
        deliver: deliverFallback,
      }),
    ).resolves.toMatchObject({
      attempted: false,
      reason: 'explicit_final_delivered',
    });
    expect(deliverFallback).not.toHaveBeenCalled();
  });

  test('marks a definitive native failure as error while preserving the final', async () => {
    const registry = new ActiveTurnOutputRegistry();
    registry.bind(SCOPE, TURN, CALLBACKS);
    const project = vi.fn(async () => true);

    await expect(
      preserveUnacknowledgedProactiveFinal({
        registry,
        scopeKey: SCOPE,
        inputTurnId: TURN,
        text: '无法送达但不能丢失的 final',
        uncertain: false,
        project,
      }),
    ).resolves.toEqual({
      projected: true,
      finalizationReason: 'error',
    });
    expect(project).toHaveBeenCalledWith('无法送达但不能丢失的 final', 'error');
  });
});
