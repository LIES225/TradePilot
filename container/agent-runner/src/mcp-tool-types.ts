import type { z } from 'zod';

export type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type McpToolResult = {
  content: McpToolContent[];
  isError?: boolean;
  [key: string]: unknown;
};

export type McpToolDefinition<Schema extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (
    args: z.infer<z.ZodObject<Schema>>,
    extra: unknown,
  ) => Promise<McpToolResult>;
};

/** Small neutral replacement for the Claude SDK's tool() constructor. */
export function defineMcpTool<Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (
    args: z.infer<z.ZodObject<Schema>>,
    extra: unknown,
  ) => Promise<McpToolResult>,
): McpToolDefinition<Schema> {
  return { name, description, inputSchema, handler };
}
