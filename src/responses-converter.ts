import { randomUUID } from 'node:crypto'
import type {
  ResponsesRequest,
  InputItem,
  ContentPart,
  ResponseTool,
  OutputItem,
  ResponseObject,
  ResponseUsage,
  UpstreamChatResponse,
} from './responses-types.js'

/**
 * Convert a Responses API request into a Chat Completions payload
 * compatible with `injectUpstreamMetadata()` and the upstream API.
 *
 * References:
 *   - chat2response/src/converter.ts:29-108 (request conversion)
 *   - routes/chat.ts:272-298 (injectUpstreamMetadata expects Record<string,unknown>)
 */
export function convertResponsesToChat(
  body: ResponsesRequest,
): Record<string, unknown> {
  const { model, input, instructions, tools, tool_choice, stream, temperature, max_tokens, top_p, user } = body
  const messages: Record<string, unknown>[] = []

  // 1. instructions → system message (prepended, see plan decision)
  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }

  // 2. input → messages array
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    let lastAssistantIdx = -1

    for (const item of input) {
      if (item.type === 'message') {
        const role = item.role === 'developer' ? 'system' : item.role ?? 'user'
        const msg: Record<string, unknown> = {
          role,
          content: extractTextContent(item.content),
        }
        messages.push(msg)
        if (role === 'assistant') lastAssistantIdx = messages.length - 1
        else lastAssistantIdx = -1
      } else if (item.type === 'function_call') {
        // Attach to last assistant message, or create a new one
        const toolCall = {
          id: item.call_id ?? `call_${randomUUID().replace(/-/g, '')}`,
          type: 'function' as const,
          function: {
            name: item.name ?? '',
            arguments: item.arguments ?? '{}',
          },
        }

        if (lastAssistantIdx >= 0) {
          const last = messages[lastAssistantIdx]
          const tcs = (last.tool_calls as unknown[]) ?? []
          tcs.push(toolCall)
          last.tool_calls = tcs
        } else {
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          })
          lastAssistantIdx = -1
        }
      } else if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: item.output ?? '',
          tool_call_id: item.call_id ?? '',
        })
        lastAssistantIdx = -1
      }
    }
  }

  // 3. Convert tools
  const chatTools = tools?.map(convertTool)

  return {
    model,
    messages,
    ...(chatTools?.length ? { tools: chatTools } : {}),
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    stream: stream ?? true,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(top_p !== undefined ? { top_p } : {}),
    ...(user !== undefined ? { user } : {}),
  }
}

/**
 * Build a Responses API ResponseObject from an upstream chat completion response.
 * Used for non-streaming responses.
 */
export function buildResponseObject(
  chatResponse: UpstreamChatResponse,
  model: string,
  input: ResponsesRequest['input'],
  responseId: string,
): ResponseObject {
  const message = chatResponse.choices[0]?.message
  const content = message?.content ?? ''
  const reasoningContent = (message as unknown as Record<string, string | undefined>)?.reasoning_content

  const output: OutputItem[] = []

  // Reasoning output item (separate, at index 0)
  if (reasoningContent) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: reasoningContent }],
    })
  }

  // Message output item (index 1 if reasoning present, else index 0)
  if (content || !reasoningContent) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: content }],
    })
  }

  // Function call outputs
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      output.push({
        id: tc.id,
        type: 'function_call',
        name: tc.function.name,
        arguments: tc.function.arguments,
        call_id: tc.id,
      })
    }
  }

  const usage: ResponseUsage | undefined = chatResponse.usage
    ? {
        input_tokens: chatResponse.usage.prompt_tokens ?? 0,
        output_tokens: chatResponse.usage.completion_tokens ?? 0,
        total_tokens: chatResponse.usage.total_tokens ?? 0,
      }
    : undefined

  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: content ? 'completed' : 'incomplete',
    input: normalizeInput(input),
    output,
    ...(usage ? { usage } : {}),
  }
}

/**
 * Normalize input to InputItem[] for the ResponseObject.
 */
function normalizeInput(input: ResponsesRequest['input']): InputItem[] {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: input }]
  }
  return input
}

/**
 * Extract text from a string or ContentPart array (responses format).
 */
function extractTextContent(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'input_text' | 'output_text' } =>
      p.type === 'input_text' || p.type === 'output_text'
    )
    .map(p => p.text ?? '')
    .join('')
}

/**
 * Convert a Responses API tool to Chat Completions tool format.
 */
function convertTool(tool: ResponseTool): Record<string, unknown> {
  // Built-in tools: web_search, code_interpreter, file_search
  if (tool.type === 'web_search' || tool.type === 'code_interpreter' || tool.type === 'file_search') {
    return {
      type: 'function',
      function: {
        name: tool.name ?? tool.type,
        description: tool.description ?? `${tool.type} tool`,
        parameters: tool.parameters ?? {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
    }
  }

  // Standard function tool
  if (tool.function) {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }
  }

  // Simple tool definition
  return {
    type: 'function',
    function: {
      name: tool.name ?? 'unknown_tool',
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }
}
