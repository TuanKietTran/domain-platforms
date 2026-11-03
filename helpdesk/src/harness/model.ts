import type { Model, ModelRequest, ModelResponse } from './types.js';

/** Deterministic word-count token approximation used across the harness. */
export function countTokens(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

export type FakeModelHandler = (request: ModelRequest) => string | undefined;

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?]/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/**
 * Deterministic stand-in for an LLM: same request always yields the same
 * response and token counts, so agent behaviour is fully testable offline.
 * An optional handler may override the text for specific tasks (returning
 * undefined falls through to the built-in templates).
 */
export class FakeModel implements Model {
  constructor(private readonly handler?: FakeModelHandler) {}

  generate(request: ModelRequest): ModelResponse {
    let text = this.handler?.(request);
    if (text === undefined) {
      if (request.task.includes('draft')) {
        const subject = request.context?.subject ?? firstSentence(request.prompt);
        const name = request.context?.customerName ?? 'there';
        text = `Hi ${name}, thanks for contacting support about "${subject}". We are looking into it now and will follow up shortly with an update.`;
      } else if (request.task.includes('summar')) {
        text = request.prompt.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 3).join(' ');
      } else {
        text = `fake-model[${request.task}]: ${firstSentence(request.prompt)}`;
      }
    }
    const inputTokens = countTokens(`${request.task} ${request.prompt}`);
    const outputTokens = countTokens(text);
    return { text, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
}
