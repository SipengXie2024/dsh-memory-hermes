/**
 * The bounded fork loop shared by the background review and the curator
 * pass: stream the model, hand each tool call to a caller-provided
 * dispatcher, feed the results back in, repeat until the model stops
 * calling tools or the step cap hits.
 *
 * The loop owns the mechanics — streaming, block assembly, message
 * threading, the per-call trace — while the caller owns the semantics:
 * which tools exist, how they dispatch, what counts as applied or
 * rejected.
 *
 * @module dsh-memory-hermes/forkloop
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { CallId, ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** One tool-call block lifted out of an assistant message. */
export interface ToolCallBlock {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** Bound a string for trace lines and activity entries. */
export function summarize(text: string): string {
  return [...text].length <= 80 ? text : `${[...text].slice(0, 80).join('')}...`
}

export interface ForkLoopOptions {
  readonly provider: GenerateOptions['provider']
  readonly model: GenerateOptions['model']
  /** Mutated in place: assistant and tool-result messages are appended. */
  readonly messages: Message[]
  readonly system?: GenerateOptions['system']
  readonly tools?: GenerateOptions['tools']
  readonly maxSteps: number
  readonly maxTokens: number
  readonly signal: AbortSignal
  readonly sessionId?: GenerateOptions['sessionId']
  /** Execute one tool call; the result text goes back to the model. */
  readonly dispatch: (toolCall: ToolCallBlock) => Promise<{ text: string; isError: boolean }>
}

export interface ForkLoopResult {
  /** LLM calls made. */
  readonly steps: number
  /** Bounded per-call trace lines (`s<step> name(args) -> ok/ERR: text`). */
  readonly trace: readonly string[]
}

export async function runForkLoop(ctx: Context, options: ForkLoopOptions): Promise<ForkLoopResult> {
  const trace: string[] = []
  /** One bounded trace line per dispatched tool call. */
  const note = (line: string): void => {
    if (trace.length < 24) trace.push([...line].length <= 140 ? line : `${[...line].slice(0, 140).join('')}...`)
  }
  let steps = 0
  while (true) {
    if (steps >= Math.max(1, options.maxSteps)) break
    steps += 1
    const generateOptions: GenerateOptions = {
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      maxTokens: options.maxTokens,
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      signal: options.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(generateOptions)) {
      options.signal.throwIfAborted()
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish.kind === 'aborted' || finish.kind === 'error') {
      const detail = `: ${JSON.stringify(finish.failure)}`
      throw new Error(`review call did not finish cleanly (${finish.kind})${detail}`)
    }
    const toolCalls: ToolCallBlock[] = assembler.blocks()
      .filter((block): block is ContentBlock & { type: 'tool-call' } => block.type === 'tool-call')
      .map(block => ({ id: block.id, name: block.name, arguments: block.arguments }))
    if (toolCalls.length === 0) break
    // Providers require tool_result blocks to follow the assistant message
    // that issued the tool_use — append the assembled assistant message
    // before the results (400 "tool_call_id is not found" otherwise).
    options.messages.push(assembler.message({ kind: 'model', provider: options.provider, model: options.model }))
    for (const toolCall of toolCalls) {
      const result = await options.dispatch(toolCall)
      note(`s${steps} ${toolCall.name}(${summarize(toolCall.arguments)}) -> ${result.isError ? 'ERR' : 'ok'}: ${result.text.split('\n')[0]}`)
      options.messages.push(createToolResultMessage({
        callId: toolCall.id as CallId,
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      }))
    }
  }
  return { steps, trace }
}
