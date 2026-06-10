// ─── OpenAI Responses API Types ────────────────────────────────
// Wire format for POST /v1/responses
// Based on OpenAI Responses API spec + chat2response reference

// ─── Request ───────────────────────────────────────────────────

export interface ResponsesRequest {
  model: string
  input: string | InputItem[]
  instructions?: string
  tools?: ResponseTool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  store?: boolean
  user?: string
  metadata?: Record<string, string>
  [key: string]: unknown
}

export interface InputItem {
  type: 'message' | 'function_call' | 'function_call_output' | 'reasoning'
  role?: 'user' | 'assistant' | 'system' | 'developer'
  content?: string | ContentPart[]
  name?: string
  arguments?: string
  call_id?: string
  output?: string
  status?: 'in_progress' | 'completed' | 'incomplete'
}

export interface ContentPart {
  type: 'input_text' | 'input_image' | 'input_file' | 'output_text' | 'refusal' | 'reasoning_text'
  text?: string
  image_url?: string
  file_url?: string
  detail?: 'auto' | 'low' | 'high'
}

export interface ResponseTool {
  type: 'function' | 'web_search' | 'code_interpreter' | 'file_search'
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

// ─── Response Object ───────────────────────────────────────────

export interface ResponseObject {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed'
  error?: ResponseError
  incomplete_details?: { reason: 'max_tokens' | 'content_filter' }
  input: InputItem[]
  output: OutputItem[]
  usage?: ResponseUsage
}

export interface OutputItem {
  id: string
  type: 'message' | 'function_call' | 'reasoning'
  role?: 'assistant'
  content?: ContentPart[]
  name?: string
  arguments?: string
  call_id?: string
  status?: 'in_progress' | 'completed'
}

export interface ResponseError {
  code: string
  message: string
  param?: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

// ─── Streaming Event Types ─────────────────────────────────────

export type StreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | ReasoningTextDeltaEvent
  | ReasoningTextDoneEvent

export interface ResponseCreatedEvent {
  type: 'response.created'
  response: ResponseObject
}

export interface ResponseInProgressEvent {
  type: 'response.in_progress'
  response: ResponseObject
}

export interface ResponseCompletedEvent {
  type: 'response.completed'
  response: ResponseObject
}

export interface ResponseFailedEvent {
  type: 'response.failed'
  response: Partial<ResponseObject> & { error: ResponseError }
}

export interface OutputItemAddedEvent {
  type: 'response.output_item.added'
  output_index: number
  item: OutputItem
}

export interface OutputItemDoneEvent {
  type: 'response.output_item.done'
  output_index: number
  item: OutputItem
}

export interface ContentPartAddedEvent {
  type: 'response.content_part.added'
  item_id: string
  output_index: number
  content_index: number
  part: ContentPart
}

export interface ContentPartDoneEvent {
  type: 'response.content_part.done'
  item_id: string
  output_index: number
  content_index: number
  part: ContentPart
}

export interface OutputTextDeltaEvent {
  type: 'response.output_text.delta'
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

export interface OutputTextDoneEvent {
  type: 'response.output_text.done'
  item_id: string
  output_index: number
  content_index: number
  text: string
}

export interface FunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta'
  item_id: string
  output_index: number
  delta: string
}

export interface FunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done'
  item_id: string
  output_index: number
  arguments: string
}

// ─── Reasoning Streaming Events ─────────────────────────────────

export interface ReasoningTextDeltaEvent {
  type: 'response.reasoning_text.delta'
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

export interface ReasoningTextDoneEvent {
  type: 'response.reasoning_text.done'
  item_id: string
  output_index: number
  content_index: number
  text: string
}

// ─── Upstream Chat Completion Chunk (for parsing) ──────────────

export interface UpstreamChatChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
      reasoning_content?: string | null
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ─── Upstream Chat Completion Response (non-streaming) ─────────

export interface UpstreamChatResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
      reasoning_content?: string | null
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}
