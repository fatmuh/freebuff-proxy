import { Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type {
  ResponsesRequest,
  InputItem,
  OutputItem,
  ResponseObject,
  StreamEvent,
  UpstreamChatChunk,
  ResponseUsage,
  ContentPart,
} from './responses-types.js'

// ─── Internal State ────────────────────────────────────────────

interface ToolCallState {
  id: string
  name: string
  arguments: string
  outputIndex: number
}

interface StreamState {
  responseId: string
  model: string
  input: ResponsesRequest['input']
  isFirstChunk: boolean
  isCompleted: boolean
  usage?: ResponseUsage

  // Reasoning item (separate output item at index 0)
  reasoningId: string
  reasoningText: string
  reasoningItemAdded: boolean
  reasoningContentAdded: boolean
  reasoningDone: boolean

  // Message item (output index: 0 if no reasoning, 1 if reasoning present)
  msgId: string
  msgText: string
  msgItemAdded: boolean
  msgContentAdded: boolean
  msgOutputIndex: number // computed: 0 or 1

  // Tool call state
  currentToolCall?: ToolCallState
  completedToolCalls: ToolCallState[]
  toolCallOutputOffset: number // tracks next available output_index for tool calls
}

function createState(model: string, input: ResponsesRequest['input']): StreamState {
  return {
    responseId: `resp_${randomUUID().replace(/-/g, '')}`,
    model,
    input,
    isFirstChunk: true,
    isCompleted: false,

    reasoningId: `rs_${randomUUID().replace(/-/g, '')}`,
    reasoningText: '',
    reasoningItemAdded: false,
    reasoningContentAdded: false,
    reasoningDone: false,

    msgId: `msg_${randomUUID().replace(/-/g, '')}`,
    msgText: '',
    msgItemAdded: false,
    msgContentAdded: false,
    msgOutputIndex: 0,

    completedToolCalls: [],
    toolCallOutputOffset: 0,
  }
}

// ─── SSE Formatting ────────────────────────────────────────────

function sse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

// ─── Helpers ───────────────────────────────────────────────────

function normInput(input: ResponsesRequest['input']): InputItem[] {
  return typeof input === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: input }]
    : input
}

function buildBaseResponse(st: StreamState): ResponseObject {
  return {
    id: st.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: st.model,
    status: 'in_progress',
    input: normInput(st.input),
    output: [],
  }
}

// ─── Response Envelope Events ──────────────────────────────────

function evCreated(st: StreamState): StreamEvent {
  return { type: 'response.created', response: { ...buildBaseResponse(st), status: 'in_progress' } }
}

function evInProgress(st: StreamState): StreamEvent {
  return { type: 'response.in_progress', response: buildBaseResponse(st) }
}

// ─── Reasoning Item Events ─────────────────────────────────────

function evReasoningOutputItemAdded(st: StreamState): StreamEvent {
  return {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: st.reasoningId, type: 'reasoning', status: 'in_progress', content: [] },
  }
}

function evReasoningOutputItemDone(st: StreamState): StreamEvent {
  return {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: st.reasoningId,
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text' as const, text: st.reasoningText }],
    },
  }
}

function evReasoningContentPartAdded(st: StreamState): StreamEvent {
  return {
    type: 'response.content_part.added',
    item_id: st.reasoningId,
    output_index: 0,
    content_index: 0,
    part: { type: 'reasoning_text' as const, text: '' },
  }
}

function evReasoningContentPartDone(st: StreamState): StreamEvent {
  return {
    type: 'response.content_part.done',
    item_id: st.reasoningId,
    output_index: 0,
    content_index: 0,
    part: { type: 'reasoning_text' as const, text: st.reasoningText },
  }
}

function evReasoningTextDelta(st: StreamState, delta: string): StreamEvent {
  return {
    type: 'response.reasoning_text.delta',
    item_id: st.reasoningId,
    output_index: 0,
    content_index: 0,
    delta,
  }
}

function evReasoningTextDone(st: StreamState): StreamEvent {
  return {
    type: 'response.reasoning_text.done',
    item_id: st.reasoningId,
    output_index: 0,
    content_index: 0,
    text: st.reasoningText,
  }
}

// ─── Message Item Events ─────────────────────────────────────────

function evMsgOutputItemAdded(st: StreamState): StreamEvent {
  return {
    type: 'response.output_item.added',
    output_index: st.msgOutputIndex,
    item: { id: st.msgId, type: 'message', role: 'assistant', content: [] },
  }
}

function evMsgOutputItemDone(st: StreamState): StreamEvent {
  return {
    type: 'response.output_item.done',
    output_index: st.msgOutputIndex,
    item: {
      id: st.msgId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text' as const, text: st.msgText }],
    },
  }
}

function evMsgContentPartAdded(st: StreamState): StreamEvent {
  return {
    type: 'response.content_part.added',
    item_id: st.msgId,
    output_index: st.msgOutputIndex,
    content_index: 0,
    part: { type: 'output_text' as const, text: '' },
  }
}

function evMsgContentPartDone(st: StreamState): StreamEvent {
  return {
    type: 'response.content_part.done',
    item_id: st.msgId,
    output_index: st.msgOutputIndex,
    content_index: 0,
    part: { type: 'output_text' as const, text: st.msgText },
  }
}

function evMsgTextDelta(st: StreamState, delta: string): StreamEvent {
  return {
    type: 'response.output_text.delta',
    item_id: st.msgId,
    output_index: st.msgOutputIndex,
    content_index: 0,
    delta,
  }
}

function evMsgTextDone(st: StreamState): StreamEvent {
  return {
    type: 'response.output_text.done',
    item_id: st.msgId,
    output_index: st.msgOutputIndex,
    content_index: 0,
    text: st.msgText,
  }
}

// ─── Tool Call Events (unchanged) ──────────────────────────────

function evFCArgDelta(tc: ToolCallState, delta: string): StreamEvent {
  return {
    type: 'response.function_call_arguments.delta',
    item_id: tc.id,
    output_index: tc.outputIndex,
    delta,
  }
}

function evFCArgDone(tc: ToolCallState): StreamEvent {
  return {
    type: 'response.function_call_arguments.done',
    item_id: tc.id,
    output_index: tc.outputIndex,
    arguments: tc.arguments,
  }
}

function evFCOutputItemAdded(tc: ToolCallState): StreamEvent {
  return {
    type: 'response.output_item.added',
    output_index: tc.outputIndex,
    item: {
      id: tc.id,
      type: 'function_call',
      name: tc.name,
      arguments: '',
      call_id: tc.id,
    },
  }
}

function evFCOutputItemDone(tc: ToolCallState): StreamEvent {
  return {
    type: 'response.output_item.done',
    output_index: tc.outputIndex,
    item: {
      id: tc.id,
      type: 'function_call',
      name: tc.name,
      arguments: tc.arguments,
      call_id: tc.id,
    },
  }
}

// ─── Completed Event ───────────────────────────────────────────

function evCompleted(st: StreamState): StreamEvent {
  const output: OutputItem[] = []

  // Reasoning item first (index 0, if present)
  if (st.reasoningText) {
    output.push({
      id: st.reasoningId,
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: st.reasoningText }],
    })
  }

  // Message item
  if (st.msgText || !st.msgItemAdded) {
    output.push({
      id: st.msgId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: st.msgText }],
    })
  }

  // Tool call items
  for (const tc of st.completedToolCalls) {
    output.push({
      id: tc.id,
      type: 'function_call',
      name: tc.name,
      arguments: tc.arguments,
      call_id: tc.id,
    })
  }

  const resp: ResponseObject = {
    id: st.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: st.model,
    status: 'completed',
    input: normInput(st.input),
    output,
    ...(st.usage ? { usage: st.usage } : {}),
  }

  return { type: 'response.completed', response: resp }
}

// ─── Finalization Events Generator ─────────────────────────────

function* finalizeEvents(st: StreamState): Generator<string> {
  if (st.isCompleted) return

  // Finalize tool calls
  if (st.currentToolCall) {
    st.completedToolCalls.push({ ...st.currentToolCall })
    st.currentToolCall = undefined
  }

  // Close reasoning item if still open (stream ended mid-reasoning)
  if (st.reasoningItemAdded && !st.reasoningDone) {
    if (st.reasoningContentAdded) {
      yield sse(evReasoningTextDone(st))
      yield sse(evReasoningContentPartDone(st))
    }
    yield sse(evReasoningOutputItemDone(st))
    st.reasoningDone = true
  }

  // Close message item
  if (st.msgItemAdded) {
    if (st.msgText.length > 0) yield sse(evMsgTextDone(st))
    if (st.msgContentAdded) yield sse(evMsgContentPartDone(st))
    yield sse(evMsgOutputItemDone(st))
  }

  // Finalize tool call items
  for (const tc of st.completedToolCalls) {
    yield sse(evFCArgDone(tc))
    yield sse(evFCOutputItemDone(tc))
  }

  yield sse(evCompleted(st))
  st.isCompleted = true
}

// ─── Initial Events Generator ──────────────────────────────────

function* initialEvents(st: StreamState): Generator<string> {
  yield sse(evCreated(st))
  yield sse(evInProgress(st))
}

// ─── Chunk Processor ───────────────────────────────────────────

function* processChunk(st: StreamState, chunk: UpstreamChatChunk): Generator<string> {
  // First chunk → emit created + in_progress
  if (st.isFirstChunk) {
    st.isFirstChunk = false
    yield* initialEvents(st)
  }

  const choice = chunk.choices?.[0]
  if (!choice) return

  const delta = choice.delta

  // 1. Reasoning content (emitted as separate reasoning output item at index 0)
  const reasoningDelta = (delta as Record<string, string | undefined | null>)?.reasoning_content
  if (reasoningDelta) {
    if (!st.reasoningItemAdded) {
      st.reasoningItemAdded = true
      yield sse(evReasoningOutputItemAdded(st))
    }
    if (!st.reasoningContentAdded) {
      st.reasoningContentAdded = true
      yield sse(evReasoningContentPartAdded(st))
    }

    st.reasoningText += reasoningDelta
    yield sse(evReasoningTextDelta(st, reasoningDelta))
  }

  // 2. Answer content delta
  const contentDelta = delta?.content
  if (contentDelta) {
    // Close reasoning item if open (transition from thinking → answer)
    if (st.reasoningItemAdded && !st.reasoningDone) {
      if (st.reasoningContentAdded) {
        yield sse(evReasoningTextDone(st))
        yield sse(evReasoningContentPartDone(st))
      }
      yield sse(evReasoningOutputItemDone(st))
      st.reasoningDone = true
      st.msgOutputIndex = 1 // message comes after reasoning
      st.toolCallOutputOffset = 2 // reasoning(0) + message(1) = 2
    }

    if (!st.msgItemAdded) {
      st.msgItemAdded = true
      yield sse(evMsgOutputItemAdded(st))
    }
    if (!st.msgContentAdded) {
      st.msgContentAdded = true
      yield sse(evMsgContentPartAdded(st))
    }

    st.msgText += contentDelta
    yield sse(evMsgTextDelta(st, contentDelta))
  }

  // 3. Tool call deltas
  if (delta?.tool_calls) {
    // Ensure message item exists even if empty (tool calls need a preceding message)
    if (!st.msgItemAdded && !st.reasoningItemAdded) {
      // No reasoning or content yet — just start message item
      st.msgItemAdded = true
      yield sse(evMsgOutputItemAdded(st))
    }
    if (!st.msgContentAdded && !st.reasoningItemAdded) {
      st.msgContentAdded = true
      yield sse(evMsgContentPartAdded(st))
    }

    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        if (st.currentToolCall) {
          st.completedToolCalls.push({ ...st.currentToolCall })
        }

        const baseIdx = st.toolCallOutputOffset > 0
          ? st.toolCallOutputOffset
          : (st.msgOutputIndex + st.completedToolCalls.length + (st.currentToolCall ? 1 : 0) + 1)

        st.currentToolCall = {
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments ?? '',
          outputIndex: baseIdx,
        }

        yield sse(evFCOutputItemAdded(st.currentToolCall))
      } else if (tc.function?.arguments && st.currentToolCall) {
        st.currentToolCall.arguments += tc.function.arguments
        yield sse(evFCArgDelta(st.currentToolCall, tc.function.arguments))
      }
    }
  }

  // 4. Capture usage from final chunk
  if (chunk.usage) {
    st.usage = {
      input_tokens: chunk.usage.prompt_tokens ?? 0,
      output_tokens: chunk.usage.completion_tokens ?? 0,
      total_tokens: chunk.usage.total_tokens ?? 0,
    }
  }

  // 5. Finish reason → finalize on next flush
  if (choice.finish_reason && st.currentToolCall && choice.finish_reason === 'tool_calls') {
    st.completedToolCalls.push({ ...st.currentToolCall })
    st.currentToolCall = undefined
  }
}

// ─── Public: Create a Node Transform stream for SSE rewriting ──
//
// Input:   upstream SSE bytes (chat.completion.chunk events)
// Output:  Responses API SSE events

export function createResponsesTransform(
  model: string,
  input: ResponsesRequest['input'],
): Transform {
  const st = createState(model, input)
  let buffer = ''

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, _encoding, callback) {
      try {
        buffer += chunk.toString('utf-8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const data = trimmed.slice(5).trim()

          if (data === '[DONE]') {
            for (const ev of finalizeEvents(st)) {
              this.push(Buffer.from(ev, 'utf-8'))
            }
            continue
          }

          try {
            const parsed = JSON.parse(data) as UpstreamChatChunk
            for (const ev of processChunk(st, parsed)) {
              this.push(Buffer.from(ev, 'utf-8'))
            }
          } catch {
            this.push(Buffer.from(line + '\n', 'utf-8'))
          }
        }

        callback()
      } catch (err) {
        callback(err as Error)
      }
    },

    flush(callback) {
      try {
        if (buffer.trim().startsWith('data:')) {
          const data = buffer.trim().slice(5).trim()
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data) as UpstreamChatChunk
              for (const ev of processChunk(st, parsed)) {
                this.push(Buffer.from(ev, 'utf-8'))
              }
            } catch { /* ignore */ }
          }
        }

        if (!st.isCompleted) {
          for (const ev of finalizeEvents(st)) {
            this.push(Buffer.from(ev, 'utf-8'))
          }
        }

        this.push(Buffer.from('data: [DONE]\n\n', 'utf-8'))
        callback()
      } catch (err) {
        callback(err as Error)
      }
    },
  })
}
