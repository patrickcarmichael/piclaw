import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildPostTimeTooltip,
  extractAgentTimingBlock,
  formatAgentReplyDuration,
  formatAgentTokenStats,
} from '../../web/src/components/post.ts';

const repoRoot = resolve(import.meta.dir, '../../..');

test('formatAgentReplyDuration keeps reply timings compact', () => {
  expect(formatAgentReplyDuration(420)).toBe('420ms');
  expect(formatAgentReplyDuration(1420)).toBe('1.4s');
  expect(formatAgentReplyDuration(38_420)).toBe('38s');
  expect(formatAgentReplyDuration(62_400)).toBe('1m 02s');
  expect(formatAgentReplyDuration(3_720_000)).toBe('1h 02m');
  expect(formatAgentReplyDuration(null)).toBe(null);
});

test('formatAgentTokenStats keeps token usage readable', () => {
  expect(formatAgentTokenStats({
    input_tokens: 1000,
    output_tokens: 234,
    cache_read_tokens: 50,
    cache_write_tokens: 25,
    total_tokens: 1309,
  })).toBe('Tokens 1,309 total · 1,000 in · 234 out · 75 cache');
  expect(formatAgentTokenStats(null)).toBe(null);
});

test('buildPostTimeTooltip includes persisted agent timing and token stats when present', () => {
  const post = {
    timestamp: '2026-06-21T11:16:02.000Z',
    data: {
      content_blocks: [
        {
          type: 'agent_timing',
          started_at: '2026-06-21T11:15:23.580Z',
          completed_at: '2026-06-21T11:16:02.000Z',
          duration_ms: 38_420,
          usage: {
            input_tokens: 1000,
            output_tokens: 234,
            cache_read_tokens: 50,
            cache_write_tokens: 25,
            total_tokens: 1309,
          },
        },
      ],
    },
  };

  expect(extractAgentTimingBlock(post.data.content_blocks)?.duration_ms).toBe(38_420);
  const tooltip = buildPostTimeTooltip(post);
  expect(tooltip).toContain('Sent');
  expect(tooltip).toContain('Agent reply took 38s');
  expect(tooltip).toContain('Tokens 1,309 total · 1,000 in · 234 out · 75 cache');
  expect(tooltip).toContain('Started');
});

test('terminal agent outcomes attach agent_timing content blocks', () => {
  const handlerSource = readFileSync(resolve(repoRoot, 'runtime/src/channels/web/handlers/agent.ts'), 'utf8');
  const streamingRuntimeSource = readFileSync(
    resolve(repoRoot, 'runtime/src/channels/web/runtime/process-chat-streaming-runtime.ts'),
    'utf8',
  );
  expect(handlerSource).toContain('onTerminalOutput: (terminalOutput) =>');
  expect(handlerSource).toContain('streamRuntime.buildAgentTimingBlock(terminalOutput.usage)');
  expect(handlerSource).toContain('streamRuntime.buildAgentTimingBlock(options.usage)');
  expect(streamingRuntimeSource).toContain('type: "agent_timing"');
  expect(streamingRuntimeSource).toContain('buildAgentTimingBlock: (usage) =>');
});
