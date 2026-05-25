---
title: Observability
description: Inspect execution, emit structured logs, and connect Flue events to monitoring and tracing tools.
---

Observability helps you answer practical questions about a Flue application:

- Did a workflow finish successfully? If not, where did it fail?
- Which agent operation or tool made a response slow?
- How many model turns did a prompt need, and what did they cost?
- What happened after an inbound event was dispatched to a persistent agent session?

Flue exposes three complementary surfaces:

1. **Workflow run history** for finite, persisted workflow executions.
2. **Structured application logs** emitted through a workflow context.
3. **`observe(...)` events** for cross-cutting logging, metrics, tracing, and error reporting across workflows and agent interactions.

Start with logs and `console.log`. Add an event observer when you need common behavior across your application or want to export telemetry to another system.

## Start with `observe(...)`

Add an `app.ts` entry to your Flue project and register an observer at module scope:

```ts title=".flue/app.ts"
import { flue, observe } from '@flue/runtime/app';
import { Hono } from 'hono';

observe((event) => {
  if (event.type === 'run_end') {
    console.log('[workflow]', event.runId, event.isError ? 'failed' : 'completed');
  }

  if (event.type === 'operation' && event.durationMs > 5_000) {
    console.warn('[slow operation]', event.operationKind, event.durationMs);
  }

  if (event.type === 'log' && event.level === 'error') {
    console.error('[application error]', event.message, event.attributes);
  }
});

const app = new Hono();
app.route('/', flue());

export default app;
```

Import `observe` from `@flue/runtime/app`. This is Flue's public integration point for application-wide telemetry: it works for a console reporter, a metrics sink, an error reporter, or a trace exporter.

The callback receives a decorated `FlueEvent` and its originating context:

```ts
observe((event, ctx) => {
  console.log(event.type, ctx.id, event.timestamp);
});
```

Observers run synchronously while an event is emitted. Keep the callback lightweight: filter events, record counters, or enqueue exporter work, but do not block application execution. If an observer throws, Flue logs the observer error and continues the original work.

### Where registration runs

On the **Node** target, module-scoped registration observes activity handled by that server process.

On the **Cloudflare** target, each isolate evaluates `app.ts` independently. An agent Durable Object therefore registers its own observer and exports its own activity. Do not rely on shared module state to aggregate telemetry across Durable Objects; export events to your external system instead.

## Workflows and agents have different lifecycles

Correct correlation starts with understanding what Flue considers finite.

A **workflow** is a bounded invocation with a persisted run history:

```text
run_start
  operation_start
    agent_start
      model turns and tools
    agent_end
  operation
run_end
```

A direct or dispatched input to an **agent session** advances a persistent conversation. It is not a workflow run:

```text
operation_start
  agent_start
    model turns and tools
  agent_end
operation
idle
```

`idle` means that current processing has settled and the session is waiting for more input. It is not the end of the agent instance or session.

### Correlation identifiers

| Field | Use it for |
| --- | --- |
| `runId` | One finite workflow invocation. Only workflow activity has this root identity. |
| `instanceId` | One persistent agent instance handling direct or dispatched input. |
| `session` / `harness` | Conversation and initialized agent-environment scopes. |
| `dispatchId` | One asynchronously accepted dispatched input. |
| `operationId` | One finite action: `prompt`, `skill`, `task`, `shell`, or `compact`. |
| `taskId` / `parentSession` | Correlating delegated child-agent activity. |
| `turnId` | One model request/response cycle within an operation. |

Use `runId` as the root for a workflow trace. For direct or dispatched agent processing, use `operationId` as the finite trace root and retain `instanceId`, `session`, and `dispatchId` as attributes.

## Add application logs

Within a workflow, use `ctx.log` to emit structured diagnostic events alongside its run history:

```ts title=".flue/workflows/summarize.ts"
import { createAgent, http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

const agent = createAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));

export async function run(ctx: FlueContext) {
  ctx.log.info('summarization started', { documentType: 'report' });

  try {
    const harness = await ctx.init(agent);
    const session = await harness.session();
    const response = await session.prompt('Summarize the report.');

    ctx.log.info('summarization complete', {
      tokens: response.usage.totalTokens,
      cost: response.usage.cost.total,
    });

    return { summary: response.text };
  } catch (error) {
    ctx.log.error('summarization failed', { error });
    throw error;
  }
}
```

`info`, `warn`, and `error` events accept structured attributes. Prefer attributes for values you will search, aggregate, or forward to monitoring tools.

During workflows, these log events are persisted with the run. During persistent-agent activity, observable log events are still available to attached streams and `observe(...)`, but they are not workflow run history because agent processing is not a run.

## Inspect workflow runs locally

Workflow events are persisted and inspectable after invocation. `flue run` reports the run identifier for the workflow it invokes; use that identifier with `flue logs`:

```bash
flue logs <workflowRunId> --server http://localhost:3583
```

Follow an active workflow run:

```bash
flue logs <workflowRunId> --server http://localhost:3583 --follow
```

Limit the stream to selected lifecycle signals or consume machine-readable events:

```bash
flue logs <workflowRunId> --types log,operation,turn,run_end --format ndjson
```

`flue logs` applies to workflows only. For direct HTTP/WebSocket prompts or dispatched agent inputs, use the attached event stream, your `observe(...)` integration, and the agent correlation fields above.

## Consume run events programmatically

For an operations dashboard or automated diagnostic process, use `@flue/sdk` to stream workflow activity:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });

for await (const event of client.runs.stream(runId)) {
  if (event.type === 'log') {
    console.log(event.level, event.message, event.attributes);
  }

  if (event.type === 'turn') {
    console.log(event.model, event.usage?.totalTokens, event.durationMs);
  }
}
```

Direct attached-agent streams and WebSocket connections expose the same agent lifecycle activity without assigning workflow run identity. This makes them useful for interactive UIs, while `observe(...)` remains the application-wide integration point.

## Trace model work, tools, and tasks

A single `session.prompt(...)` may perform multiple model turns, especially when tools are involved. Flue exposes a normalized model-turn pair for exporters and debugging tools:

| Event | Meaning |
| --- | --- |
| `turn_start` | A Pi-aligned agent-loop turn began. |
| `turn_request` | The normalized request about to be sent to the model. |
| `turn` | The normalized terminal model output, timing, usage, and failure state. |

`turn_request` and `turn` share a `turnId`. `turn_request` includes the model/provider/API identity, effective reasoning setting when present, model-visible messages, system prompt, and available tool definitions. `turn` includes normalized assistant output, duration, usage/cost, stop reason, and error status.

For example, an exporter can represent a tool-using prompt as:

```text
operation: prompt
  llm turn: asks to call lookup_weather
    tool: lookup_weather
  llm turn: reads tool result and returns an answer
```

Model calls used for context compaction are also visible. They carry `purpose: 'compaction'` or `purpose: 'compaction_prefix'`, rather than appearing as ordinary agent decisions. Ordinary agent-loop turns carry `purpose: 'agent'`.

A useful span mapping is:

| Flue lifecycle events | Trace concept |
| --- | --- |
| `run_start` / `run_end` | Workflow root span |
| `operation_start` / `operation` | Operation span; root for direct/dispatched input processing |
| `agent_start` / `agent_end` | Optional agent-loop span |
| `turn_request` / `turn` | LLM generation span |
| `tool_start` / `tool_call` | Tool span |
| `task_start` / `task` | Delegated task span |
| `compaction_start` / `compaction` | Context-compaction span |
| `log` | Breadcrumb, log event, or error signal |

## Forward failures to an error reporter

Error reporting does not require tracing every event. A simple integration can capture unhandled workflow failures and explicit application error logs:

```ts title=".flue/app.ts"
import { flue, observe } from '@flue/runtime/app';
import { Hono } from 'hono';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
});

observe((event) => {
  if (event.type === 'run_end' && event.isError) {
    Sentry.captureException(event.error);
  }

  if (event.type === 'log' && event.level === 'error') {
    Sentry.captureMessage(event.message, 'error');
  }
});

const app = new Hono();
app.route('/', flue());
export default app;
```

Start narrowly. Model and tool errors may be recovered within an agent loop; exporting every recoverable failure as an incident can produce noisy alerts. Use terminal workflow failures and deliberate `ctx.log.error(...)` calls as a sensible baseline.

See the [`examples/sentry/`](https://github.com/withastro/flue/tree/main/examples/sentry) project for a complete error-reporting integration.

## Export traces to an observability platform

For full AI traces, translate correlated events into your provider's spans. The [`examples/braintrust/`](https://github.com/withastro/flue/tree/main/examples/braintrust) project demonstrates a public `observe(...)`-only bridge that creates:

- workflow root spans;
- operation, task, and compaction spans;
- model-generation spans with request/output and token/cost data;
- nested tool spans.

The same event model can be mapped to OpenTelemetry, Braintrust, Sentry tracing, or an internal trace store. `observe(...)` gives an adapter the Flue-level execution semantics. A vendor may separately use provider SDK instrumentation or Node-specific wrappers when it needs live async context for provider-native spans; application code does not need to depend on private Flue runtime internals to understand the Flue trace.

## Handle sensitive content carefully

Flue events may contain substantial application and model data, including:

- workflow payloads and returned results;
- application log attributes;
- system prompts and model-visible messages;
- model output and supported thinking content;
- tool arguments and results;
- delegated task prompts and results;
- images and other large encoded content.

`turn_request` and `turn` intentionally provide full-fidelity model telemetry. Before sending events to an external service:

- choose which event types and fields you need;
- remove or redact secrets and personal data;
- confirm your provider's data retention and access controls;
- avoid exporting content at all when aggregate duration, error, token, and cost metrics are sufficient.

`session.shell(command, { env })` redacts environment values in its recorded tool representation, but arbitrary tool results or model output may still contain sensitive values.

Workflow event history persists full-fidelity events subject to a **1 MB per-event limit**. Very large content-bearing events may cause workflow persistence to fail rather than silently store incomplete telemetry.

## Recommended progression

A practical observability setup can grow in stages:

1. **Local development:** log selected `observe(...)` events to the console and inspect workflows with `flue logs`.
2. **Production diagnostics:** emit structured `ctx.log` events and forward terminal failures to an error reporter.
3. **Operational monitoring:** derive latency, token, cost, and error metrics from terminal operation and model-turn events.
4. **Full tracing:** map operations, turns, tools, tasks, and compactions to spans in Braintrust, OpenTelemetry, Sentry, or another tracing backend.

Start with the questions your application needs answered, and add telemetry only where it helps you debug, monitor, or improve behavior.
