import { z } from 'zod';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import type { McpToolDefinition } from '../../mcp-tool-types.js';

type PiToolDefinition = ToolDefinition<any>;

function toPiSchema(tool: McpToolDefinition<any>): TSchema {
  try {
    // Miniclaw's existing MCP definitions are Zod raw shapes. Zod v4 can
    // export a standards-compatible schema; Type.Unsafe keeps that schema
    // intact while satisfying Pi's TypeBox-facing contract.
    const schema = z.toJSONSchema(z.object(tool.inputSchema as any));
    delete (schema as Record<string, unknown>).$schema;
    return Type.Unsafe(schema);
  } catch {
    // A malformed optional tool must not prevent the core runtime from
    // starting. prepareArguments below still validates at execution time.
    return Type.Object({});
  }
}

function toPiContent(value: unknown): Array<TextContent | ImageContent> {
  if (!value || typeof value !== 'object') {
    return [{ type: 'text', text: String(value ?? '') }];
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: JSON.stringify(value) }];
  }
  return content.map((item) => {
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'image' &&
      typeof (item as { data?: unknown }).data === 'string'
    ) {
      return {
        type: 'image' as const,
        data: (item as { data: string }).data,
        mimeType:
          typeof (item as { mimeType?: unknown }).mimeType === 'string'
            ? (item as { mimeType: string }).mimeType
            : 'image/jpeg',
      };
    }
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      return { type: 'text' as const, text: (item as { text: string }).text };
    }
    return { type: 'text' as const, text: JSON.stringify(item) };
  });
}

/** Adapt existing in-process Claude MCP tools to Pi custom tools. */
export function adaptClaudeMcpToolsToPi(
  tools: McpToolDefinition<any>[],
  options: { namespace?: string } = {},
): PiToolDefinition[] {
  const namespace = options.namespace?.trim().replace(/:+$/, '');
  return tools.map((tool) =>
    defineTool({
      name: namespace ? `${namespace}__${tool.name}` : tool.name,
      label: namespace ? `${namespace}__${tool.name}` : tool.name,
      description: tool.description,
      parameters: toPiSchema(tool),
      prepareArguments: (args: unknown) =>
        z.object(tool.inputSchema as any).parse(args),
      execute: async (toolCallId, params, signal) => {
        const result = await tool.handler(params as Record<string, unknown>, {
          signal,
          toolCallId,
        });
        return {
          content: toPiContent(result),
          details: result,
        };
      },
    }),
  );
}
