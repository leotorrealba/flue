/**
 * Pure classifier for the persisted state of an agent-submission input.
 *
 * Given the active-path entries that follow a persisted submission input,
 * `classifySubmissionState` determines how far the submission progressed
 * before the session was last saved. It is the single source of truth for
 * both consumers in `session.ts`:
 *
 * - `inspectPersistedInput`, which maps the fine-grained state onto the
 *   coarse `AgentSubmissionInspection` union used by reconciliation, and
 * - the `runPersistedContextInput` preamble, which decides whether to
 *   resume, settle, or fail when (re)processing the input.
 *
 * The two consumers intentionally do NOT agree on every state. The current
 * divergences, preserved verbatim from the pre-consolidation
 * implementations and pinned by `test/submission-state.test.ts`:
 *
 * - `resume` with mode `overflow`, `transient_retry`, or `input_only`: the
 *   preamble resumes these, but inspection reports `'uncertain'` —
 *   reconciliation compensates with its uncertain-before-provider retry
 *   special case (see `reconcileInterruptedSubmission`).
 * - `completed` with `overflow: true` (silent or truncation overflow on a
 *   stop/length response): inspection reports `'completed'`, but the
 *   preamble treats it as an overflow resume (compact and continue).
 * - `tool_use_unresolved`: inspection reports `'uncertain'`, but the
 *   preamble settles with the persisted response without resuming.
 * - `advanced_past_input`: inspection reports `'uncertain'`, the preamble
 *   fails the operation.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from './compaction.ts';
import type { MessageEntry, SessionEntry } from './types.ts';

/**
 * How a `resume` state continues the interrupted submission:
 *
 * - `input_only` — the input was applied but no assistant response was
 *   persisted; start the first turn.
 * - `tool_results` — a toolUse response with persisted tool results;
 *   continue the loop from the results.
 * - `stream_continuation` — an aborted response already recovered from
 *   persisted stream chunks (a `stream_continued` signal follows it);
 *   continue from the recovered partial.
 * - `transient_retry` — a retryable model error; wait out the backoff and
 *   retry the turn.
 * - `overflow` — a context-overflow response; compact and retry the turn.
 */
type SubmissionResumeMode =
	| 'input_only'
	| 'tool_results'
	| 'stream_continuation'
	| 'transient_retry'
	| 'overflow';

export type SubmissionState =
	/** The persisted input entry was not found in session history. */
	| { kind: 'absent' }
	/** A later user input exists: the session moved on without settling this input. */
	| { kind: 'advanced_past_input' }
	/**
	 * The last assistant response is canonical (stopReason stop/length).
	 * `overflow` flags silent/truncation overflow on that response — see the
	 * module doc for the consumer divergence it encodes.
	 */
	| { kind: 'completed'; assistant: AssistantMessage; overflow: boolean }
	/** A toolUse response with no persisted tool results. */
	| { kind: 'tool_use_unresolved'; assistant: AssistantMessage }
	| {
			kind: 'resume';
			mode: 'input_only';
			assistant?: undefined;
			consecutiveRetryableErrors: number;
	  }
	| {
			kind: 'resume';
			mode: Exclude<SubmissionResumeMode, 'input_only'>;
			assistant: AssistantMessage;
			consecutiveRetryableErrors: number;
	  }
	/** A non-resumable error or aborted response. */
	| { kind: 'terminal_error'; reason: string };

/**
 * Classify how far a persisted submission input progressed.
 *
 * @param following - `history.getActivePathSince(inputEntry.id)` for the
 *   persisted input entry, or `undefined` when the input entry is absent
 *   from history.
 * @param opts.contextWindow - The active model's context window, used for
 *   silent-overflow detection; pass 0 when no model is resolved (only
 *   explicit overflow error messages are detected then).
 */
export function classifySubmissionState(
	following: SessionEntry[] | undefined,
	opts: { contextWindow: number },
): SubmissionState {
	if (following === undefined) return { kind: 'absent' };
	if (following.some((entry) => entry.type === 'message' && entry.message.role === 'user')) {
		return { kind: 'advanced_past_input' };
	}
	const assistant = following.findLast(
		(entry): entry is MessageEntry => entry.type === 'message' && entry.message.role === 'assistant',
	)?.message as AssistantMessage | undefined;
	if (!assistant) {
		return {
			kind: 'resume',
			mode: 'input_only',
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	const overflow = isContextOverflow(assistant, opts.contextWindow);
	if (isCompletedAssistantResponse(assistant)) {
		return { kind: 'completed', assistant, overflow };
	}
	if (overflow) {
		return {
			kind: 'resume',
			mode: 'overflow',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (isRetryableModelError(assistant)) {
		return {
			kind: 'resume',
			mode: 'transient_retry',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (
		assistant.stopReason === 'aborted' &&
		following.some(
			(entry) =>
				entry.type === 'message' &&
				entry.message.role === 'signal' &&
				entry.message.type === 'stream_continued',
		)
	) {
		return {
			kind: 'resume',
			mode: 'stream_continuation',
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
		};
	}
	if (assistant.stopReason === 'toolUse') {
		if (following.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult')) {
			return {
				kind: 'resume',
				mode: 'tool_results',
				assistant,
				consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following),
			};
		}
		return { kind: 'tool_use_unresolved', assistant };
	}
	// stopReason 'error' (non-retryable, non-overflow) or 'aborted' without a
	// recovered stream continuation.
	return { kind: 'terminal_error', reason: assistant.errorMessage ?? assistant.stopReason };
}

export function isRetryableModelError(message: AssistantMessage): boolean {
	if (message.stopReason !== 'error' || !message.errorMessage) return false;
	return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i.test(
		message.errorMessage,
	);
}

export function isCompletedAssistantResponse(message: AssistantMessage): boolean {
	return message.stopReason === 'stop' || message.stopReason === 'length';
}

export function countConsecutiveRetryableModelErrors(entries: SessionEntry[]): number {
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== 'message') continue;
		// User messages mark an operation boundary: errors from a previous
		// operation must not count against the current one.
		if (entry.message.role === 'user') return count;
		if (entry.message.role !== 'assistant') continue;
		if (!isRetryableModelError(entry.message as AssistantMessage)) return count;
		count += 1;
	}
	return count;
}
