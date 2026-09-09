# AI.md

## 1. Philosophy

WatchDog's agentic-AI layer exists to assist operators, not replace them.

The v1 invariant is:

> AI may draft, summarize, suggest, and prepare actions, but humans decide. No customer-facing action is posted, sent, or applied autonomously in v1.

This applies to every AI-assisted workflow:

- Incident updates are drafted by AI, then reviewed and published by an authorized user.
- Impact and affected-service suggestions are advisory only.
- Postmortems are generated as drafts only.
- Natural-language queries are read-only.
- Weekly digests are generated for review and delivery through the notification channel.

The AI layer is a product capability under the `ai` module. It must not own incident state, service state, monitoring results, notification delivery, or tenant resolution. Those remain owned by their respective domain modules.

For architecture, module topology, CQRS boundaries, and runtime shape, see `ARCHITECTURE.md`.

For entity definitions, domain events, incident lifecycle, uptime rollups, and RLS mechanics, see `DOMAIN.md`.

For notification delivery details, see the notification section in the owning documentation.

---

## 2. Provider Port

The WatchDog core must remain provider-agnostic. All LLM access goes through a narrow provider port owned by the `ai` module.

The v1 implementation adapter is Azure AI Foundry.

> TODO(human): Specify the exact Azure AI Foundry model name, deployment name, API version, endpoint configuration, and credential source.

### 2.1 Design Constraints

- Domain handlers must depend on a TypeScript interface, not an SDK client.
- Provider-specific request/response formats stay inside the adapter.
- Use cases should express intent through typed inputs and output schemas.
- Structured output must be validated before it leaves the AI module boundary.
- Provider failures must degrade into unavailable AI assistance, not failed core product flows.
- AI outputs are never trusted as facts without linking back to source entities or events.

### 2.2 TypeScript Port Sketch

```ts
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmCompletionRequest {
  orgId: string;
  purpose:
    | 'incident-copilot'
    | 'nl-query'
    | 'weekly-digest'
    | 'postmortem-draft';

  messages: LlmMessage[];

  temperature?: number;
  maxOutputTokens?: number;

  metadata?: {
    actorUserId?: string;
    incidentId?: string;
    maintenanceId?: string;
    serviceIds?: string[];
    correlationId?: string;
  };
}

export interface LlmCompletionResponse {
  text: string;
  usage?: LlmUsage;
  providerRequestId?: string;
}

export interface StructuredOutputSchema<T> {
  name: string;
  description?: string;

  /**
   * Runtime validation remains mandatory.
   * The concrete implementation may use TypeBox, JSON Schema, or another
   * schema representation consistent with the rest of the codebase.
   */
  schema: unknown;

  parse(value: unknown): T;
}

export interface LlmStructuredRequest<T> extends LlmCompletionRequest {
  output: StructuredOutputSchema<T>;
}

export interface LlmProviderPort {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;

  completeStructured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<{
    value: T;
    rawText?: string;
    usage?: LlmUsage;
    providerRequestId?: string;
  }>;
}
```

### 2.3 Azure AI Foundry Adapter Sketch

```ts
export interface AzureAiFoundryConfig {
  endpoint: string;
  apiKey?: string;
  deploymentName: string;
  apiVersion: string;
}

export class AzureAiFoundryLlmProvider implements LlmProviderPort {
  constructor(private readonly config: AzureAiFoundryConfig) {}

  async complete(
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    // Map provider-agnostic messages to Azure AI Foundry request shape.
    // Execute request.
    // Normalize provider response into LlmCompletionResponse.
    throw new Error('Not implemented');
  }

  async completeStructured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<{
    value: T;
    rawText?: string;
    usage?: LlmUsage;
    providerRequestId?: string;
  }> {
    // Ask provider for structured output where supported.
    // Validate with request.output.parse before returning.
    throw new Error('Not implemented');
  }
}
```

---

## 3. v1 Capabilities

## 3.1 Incident Copilot

Incident Copilot assists operators during and after an incident. It does not publish updates or mutate customer-facing state without human approval.

### Trigger

Incident Copilot can be triggered by:

- An authorized user opening an incident workspace.
- An authorized user requesting a draft incident update.
- A monitor producing a draft incident candidate after N consecutive failures.
- An authorized user requesting impact or affected-service suggestions.
- An authorized user requesting a postmortem draft after incident resolution.

### Inputs

Domain entities and events:

- `Incident`
- `IncidentUpdate`
- `Service`
- `ServiceGroup`
- `Monitor`
- `CheckResult`
- `UptimeRollup`
- Incident lifecycle events from `DOMAIN.md`
- Monitoring failure/recovery events from `DOMAIN.md`

Context envelope:

```ts
export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export interface IncidentCopilotContext {
  orgId: string;
  actorUserId: string;

  incident: {
    id: string;
    title: string;
    status: 'draft' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
    impact?: IncidentImpact;
    startedAt: string;
    resolvedAt?: string;
  };

  affectedServices: Array<{
    id: string;
    name: string;
    currentStatus: string;
    manualOverrideStatus?: string;
  }>;

  recentUpdates: Array<{
    id: string;
    body: string;
    createdAt: string;
    createdByUserId: string;
  }>;

  recentCheckResults?: Array<{
    monitorId: string;
    serviceId: string;
    checkedAt: string;
    status: 'success' | 'failure';
    latencyMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }>;

  relatedMaintenanceIds?: string[];
}
```

### Output Shape

```ts
export interface IncidentCopilotOutput {
  suggestedImpact?: {
    value: 'none' | 'minor' | 'major' | 'critical';
    rationale: string;
  };

  suggestedAffectedServices?: Array<{
    serviceId: string;
    confidence: 'low' | 'medium' | 'high';
    rationale: string;
  }>;

  draftUpdate?: {
    title?: string;
    body: string;
    intendedStatus?:
      | 'draft'
      | 'investigating'
      | 'identified'
      | 'monitoring'
      | 'resolved';
  };

  postmortemDraft?: {
    summary: string;
    impact: string;
    timeline: Array<{
      timestamp: string;
      description: string;
      sourceIncidentUpdateId?: string;
      sourceCheckResultId?: string;
    }>;
    rootCause?: string;
    resolution: string;
    followUps: Array<{
      title: string;
      ownerHint?: string;
      priority: 'low' | 'medium' | 'high';
    }>;
  };

  caveats: string[];
}
```

### Human Approval Gate

Incident Copilot output must be presented as a draft or suggestion.

The user must explicitly approve before WatchDog:

- Creates an `IncidentUpdate`.
- Changes incident status.
- Changes impact.
- Changes affected services.
- Sends notifications.
- Publishes postmortem content.

Approval should capture:

```ts
export interface AiApprovalRecord {
  orgId: string;
  actorUserId: string;
  aiPurpose: 'incident-copilot' | 'postmortem-draft';
  approvedAt: string;
  sourceDraftId: string;
  resultingEntityType: 'incident_update' | 'incident' | 'postmortem';
  resultingEntityId: string;
}
```

---

## 3.2 Natural-Language Query

Natural-Language Query allows authorized users to ask questions over status, incident, maintenance, monitoring, and uptime history.

It is strictly read-only in v1.

### Trigger

Triggered when an authorized user submits a natural-language question from the admin dashboard or another authenticated internal surface.

Example questions:

- "Which services had the most downtime this week?"
- "Show incidents affecting checkout in the last 30 days."
- "What was the uptime for the API service over the last 90 days?"
- "Were there any incidents during scheduled maintenance?"

These examples are illustrative only and must not be treated as hardcoded prompts.

### Inputs

Domain entities and read models:

- `Organization`
- `Service`
- `ServiceGroup`
- `Incident`
- `IncidentUpdate`
- `Maintenance`
- `Monitor`
- `CheckResult`
- `UptimeRollup`

The AI layer receives the active `orgId` from CQRS context. It must not accept tenant scope from free-form user text.

### NL to Safe Query Flow

Natural language must never be converted into free SQL.

The flow is:

```text
User question
  -> AI structured intent
  -> validated query object
  -> allowlisted query handler
  -> parameterized repository method
  -> answer with cited source rows/entities
```

The LLM may produce a structured query intent such as:

```ts
export type NlQueryIntent =
  | {
      kind: 'incident_search';
      serviceIds?: string[];
      statuses?: Array<'draft' | 'investigating' | 'identified' | 'monitoring' | 'resolved'>;
      impact?: Array<'none' | 'minor' | 'major' | 'critical'>;
      from?: string;
      to?: string;
      limit?: number;
    }
  | {
      kind: 'uptime_summary';
      serviceIds?: string[];
      from: string;
      to: string;
      bucket: 'day' | 'week' | 'month';
    }
  | {
      kind: 'maintenance_search';
      serviceIds?: string[];
      from?: string;
      to?: string;
      states?: Array<'scheduled' | 'in_progress' | 'completed'>;
      limit?: number;
    }
  | {
      kind: 'status_history';
      serviceIds?: string[];
      from: string;
      to: string;
    };
```

The query dispatcher must reject:

- Unknown intent kinds.
- Unbounded time ranges.
- Missing required date bounds for history queries.
- Requests for cross-org data.
- Requests to mutate state.
- Requests to reveal raw prompts, hidden instructions, secrets, or unrelated internal data.

### Output Shape

```ts
export interface NlQueryAnswer {
  question: string;

  interpretedIntent: NlQueryIntent;

  answer: string;

  rows?: Array<Record<string, unknown>>;

  sources: Array<{
    entityType:
      | 'service'
      | 'incident'
      | 'incident_update'
      | 'maintenance'
      | 'monitor'
      | 'check_result'
      | 'uptime_rollup';
    entityId: string;
    label?: string;
    timestamp?: string;
  }>;

  caveats: string[];
}
```

### Human Approval Gate

No approval is required to display read-only answers to authorized users.

However:

- The answer must not perform writes.
- The answer must not send notifications.
- The answer must not publish customer-facing content.
- Any proposed follow-up action must become a separate draft requiring explicit human approval.

---

## 3.3 Weekly Digest

Weekly Digest summarizes each organization's operational history for the week.

### Trigger

Triggered by a scheduled application workflow.

The digest may also be generated manually by an authorized user for preview.

### Inputs

Domain entities and events:

- `Incident`
- `IncidentUpdate`
- `Maintenance`
- `Service`
- `Monitor`
- `CheckResult`
- `UptimeRollup`
- Notification subscriber/channel configuration from the notification module

Time window:

```ts
export interface WeeklyDigestWindow {
  orgId: string;
  from: string;
  to: string;
  timezone: string;
}
```

Digest input:

```ts
export interface WeeklyDigestInput {
  orgId: string;
  window: WeeklyDigestWindow;

  services: Array<{
    id: string;
    name: string;
    groupId?: string;
  }>;

  incidents: Array<{
    id: string;
    title: string;
    impact?: 'none' | 'minor' | 'major' | 'critical';
    status: 'draft' | 'investigating' | 'identified' | 'monitoring' | 'resolved';
    startedAt: string;
    resolvedAt?: string;
    affectedServiceIds: string[];
    updateCount: number;
  }>;

  maintenanceWindows: Array<{
    id: string;
    title: string;
    state: 'scheduled' | 'in_progress' | 'completed';
    startsAt: string;
    endsAt: string;
    affectedServiceIds: string[];
  }>;

  uptime: Array<{
    serviceId: string;
    date: string;
    uptimePercentage: number;
    totalChecks: number;
    failedChecks: number;
  }>;
}
```

### Output Shape

```ts
export interface WeeklyDigestDraft {
  subject: string;

  summary: string;

  highlights: string[];

  incidentSummary: Array<{
    incidentId: string;
    title: string;
    impact?: 'none' | 'minor' | 'major' | 'critical';
    impactSummary: string;
    timelineSummary: string;
  }>;

  uptimeSummary: Array<{
    serviceId: string;
    serviceName: string;
    uptimePercentage: number;
    notableEvents: string[];
  }>;

  maintenanceSummary: Array<{
    maintenanceId: string;
    title: string;
    outcome: string;
  }>;

  recommendedFollowUps: Array<{
    title: string;
    rationale: string;
    priority: 'low' | 'medium' | 'high';
  }>;

  caveats: string[];
}
```

### Human Approval Gate

Weekly Digest is generated as a draft.

Before delivery through the notification channel:

- An authorized user must preview the content.
- An authorized user must approve sending.
- The notification module performs delivery after approval.

For notification channel behavior, see the owning notification documentation.

---

## 4. Guardrails

## 4.1 Tenant Scoping

The AI layer may only access data for the active organization.

The same CQRS context and RLS enforcement used by non-AI application flows applies to AI use cases.

Rules:

- AI use cases receive `orgId` from authenticated CQRS context.
- AI use cases must not trust user-provided `orgId` values in prompts.
- Repository calls execute under the same tenant-scoped transaction contract as the rest of the application.
- Prompt construction must happen after tenant-scoped data retrieval.
- Cross-org summaries, comparisons, or leakage are forbidden in v1.

RLS details are owned by `DOMAIN.md`.

Request lifecycle and tenant-context injection are owned by `ARCHITECTURE.md`.

## 4.2 No Autonomous Posting

AI must not directly perform customer-facing writes.

Forbidden autonomous actions in v1:

- Publishing incident updates.
- Resolving incidents.
- Creating public maintenance notices.
- Sending digest emails.
- Sending subscriber notifications.
- Changing service status.
- Creating remediation actions.
- Posting to RSS/Atom feeds.

Allowed actions:

- Drafting.
- Summarizing.
- Suggesting.
- Producing structured read-only query intents.
- Preparing human-reviewable content.

## 4.3 Prompt Injection Resistance for NL Query

Natural-language input must be treated as untrusted user content.

The NL Query feature must ignore attempts to:

- Override system or developer instructions.
- Request raw SQL execution.
- Request secrets, credentials, or hidden prompts.
- Request data outside the active organization.
- Bypass role checks.
- Convert a read-only flow into a write operation.

The LLM output is only an intermediate structured intent. It must pass validation and be executed through allowlisted query handlers.

```ts
export interface NlQueryGuardrailResult {
  allowed: boolean;
  reason?: string;
  normalizedQuestion?: string;
}
```

## 4.4 PII and Log Handling

AI requests may contain operational metadata, incident descriptions, and user-authored updates. Treat this data as sensitive.

Rules:

- Do not log full prompts by default.
- Do not log raw LLM responses by default.
- Log correlation IDs, purpose, org ID, actor user ID, provider request ID, latency, and token counts where available.
- Redact email addresses, tokens, URLs with embedded credentials, headers, and secrets.
- Avoid including raw check payloads unless explicitly needed.
- Prefer compact summaries over full event dumps.
- Store AI drafts as application data only when needed for review, approval, or audit.
- Retain approval records for customer-facing AI-assisted actions.

Suggested audit metadata:

```ts
export interface AiAuditMetadata {
  orgId: string;
  actorUserId?: string;
  purpose:
    | 'incident-copilot'
    | 'nl-query'
    | 'weekly-digest'
    | 'postmortem-draft';

  provider: 'azure-ai-foundry';
  providerRequestId?: string;

  inputEntityRefs: Array<{
    entityType: string;
    entityId: string;
  }>;

  outputDraftId?: string;

  approvedActionId?: string;

  createdAt: string;
}
```

---

## 5. Roadmap AI

Roadmap items are not part of v1. They must remain gated, auditable, and tenant-scoped when implemented.

For full roadmap sequencing and non-goals, see `ROADMAP.md`.

## 5.1 Correlation / Triage Agent

Goal: correlate monitor failures, service impact, recent incidents, and maintenance windows to help operators triage faster.

Potential capabilities:

- Group related monitor failures.
- Suggest likely affected services.
- Identify whether an incident overlaps with scheduled maintenance.
- Propose incident title, impact, and initial update.
- Recommend whether to create a draft incident.

Sketch:

```ts
export interface CorrelationTriageInput {
  orgId: string;

  failureWindow: {
    from: string;
    to: string;
  };

  checkResults: Array<{
    id: string;
    monitorId: string;
    serviceId: string;
    checkedAt: string;
    status: 'success' | 'failure';
    errorCode?: string;
    errorMessage?: string;
  }>;

  activeIncidents: Array<{
    id: string;
    title: string;
    affectedServiceIds: string[];
    status: string;
  }>;

  activeMaintenance: Array<{
    id: string;
    title: string;
    affectedServiceIds: string[];
    startsAt: string;
    endsAt: string;
  }>;
}

export interface CorrelationTriageOutput {
  groups: Array<{
    label: string;
    serviceIds: string[];
    monitorIds: string[];
    confidence: 'low' | 'medium' | 'high';
    rationale: string;
  }>;

  suggestedDraftIncident?: {
    title: string;
    impact: 'none' | 'minor' | 'major' | 'critical';
    affectedServiceIds: string[];
    initialUpdate: string;
  };

  caveats: string[];
}
```

Human gate:

- The agent may create a draft recommendation.
- An authorized user must approve incident creation or publication.

## 5.2 Remediation Agent

Goal: recommend or prepare remediation steps using WatchDog context and external operational tools.

This is roadmap only.

Potential capabilities:

- Suggest runbook steps.
- Prepare remediation commands for review.
- Link likely cause to recent failures.
- Open a gated remediation workflow.

The remediation agent must be tool-use gated. It must not execute infrastructure-changing actions autonomously.

Sketch:

```ts
export interface RemediationToolRequest {
  orgId: string;
  actorUserId: string;

  incidentId: string;

  proposedAction: {
    toolName: string;
    description: string;
    parameters: Record<string, unknown>;
    riskLevel: 'low' | 'medium' | 'high';
  };

  approvalRequired: true;
}

export interface RemediationApproval {
  orgId: string;
  actorUserId: string;
  incidentId: string;
  approvedAt: string;
  approvedToolName: string;
  approvedParameters: Record<string, unknown>;
}
```

Hard requirements:

- Every tool action requires explicit human approval.
- High-risk actions require stronger confirmation.
- Tool input must be validated against an allowlist.
- Tool output must be recorded in the incident audit trail.
- Failed remediation must not mutate incident state automatically.

## 5.3 MCP Server

Roadmap: expose WatchDog tools to external agents through an MCP server.

The MCP server should expose constrained, tenant-aware tools that map to existing WatchDog commands and queries.

Potential tool categories:

- Read current org status.
- Search incidents.
- Read uptime summaries.
- Draft incident updates.
- Draft postmortems.
- Draft weekly digests.
- Prepare remediation proposals.

The MCP server must not bypass WatchDog authorization, CQRS handlers, RLS, or human approval gates.

Sketch:

```ts
export interface WatchDogMcpToolContext {
  orgId: string;
  actorUserId: string;
  role: 'owner' | 'admin' | 'member';
  correlationId: string;
}

export interface WatchDogMcpTool<I, O> {
  name: string;
  description: string;
  inputSchema: unknown;

  execute(input: I, context: WatchDogMcpToolContext): Promise<O>;
}
```

Example tools:

```ts
export interface DraftIncidentUpdateInput {
  incidentId: string;
  operatorNotes?: string;
}

export interface DraftIncidentUpdateOutput {
  draftId: string;
  incidentId: string;
  body: string;
  requiresApproval: true;
}

export interface QueryUptimeInput {
  serviceIds?: string[];
  from: string;
  to: string;
  bucket: 'day' | 'week' | 'month';
}

export interface QueryUptimeOutput {
  rows: Array<{
    serviceId: string;
    bucketStart: string;
    uptimePercentage: number;
    totalChecks: number;
    failedChecks: number;
  }>;
}
```

MCP guardrails:

- Tools must execute through existing application use cases.
- Tools must preserve tenant scoping.
- Tools must expose drafts instead of direct customer-facing writes.
- Tools must return source entity references for generated content.
- External agents must not receive broader data access than the authenticated user.
