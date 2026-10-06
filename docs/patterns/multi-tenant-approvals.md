---
title: "Multi-Tenant Approvals"
description: "Resolve tenant policy asynchronously for authored tools, OpenAPI operations, and MCP tools."
---

Use an async `approval` policy to ask your application whether a tenant may run a tool automatically, must get human approval, or cannot run it. The policy receives session identity, the qualified tool name, input, and previously approved tools.

Use this with [multi-tenant outbound auth](./multi-tenant-auth) when your own
API key, JWT, or app session establishes the tenant and the connection
credential is selected from your credential store rather than OAuth.

Write one adapter for your tenant policy and reuse it in authored tools, OpenAPI connections, and MCP connections. Your application owns policy storage.

## Adapt tenant policy to eve approval

The current caller and initiating caller are both available on the session. This example requires them to belong to the same tenant before consulting policy:

```ts title="agent/lib/tenant-approval.ts"
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { approvalPolicies } from "./approval-policies";

type Surface = "connection" | "tool";

function tenantIdOf(auth: ApprovalContext["session"]["auth"]["current"]): string | null {
  const tenantId = auth?.attributes.tenantId;
  return typeof tenantId === "string" ? tenantId : null;
}

export async function decideTenantApproval(
  surface: Surface,
  ctx: ApprovalContext,
): Promise<ApprovalStatus> {
  const current = ctx.session.auth.current;
  const tenantId = tenantIdOf(current);
  const initiatorTenantId = tenantIdOf(ctx.session.auth.initiator);

  if (current?.principalType !== "user" || !tenantId || tenantId !== initiatorTenantId) {
    return { type: "denied", reason: "The session is not pinned to one tenant user." };
  }

  const input = ctx.toolInput as Record<string, unknown> | undefined;
  if (typeof input?.tenantId === "string" && input.tenantId !== tenantId) {
    return { type: "denied", reason: "Tool input cannot select another tenant." };
  }

  const policy = await approvalPolicies.decide({
    tenantId,
    userId: current.principalId,
    resource: `${surface}:${ctx.toolName}`,
    input,
  });

  switch (policy.decision) {
    case "allow":
      return { type: "approved", reason: policy.reason };
    case "require-approval":
      return "user-approval";
    case "deny":
      return { type: "denied", reason: policy.reason };
  }
}
```

For authored tools, `ctx.toolName` is the path-derived name such as `transfer_funds`. For connection tools, it is qualified, such as `billing__updateSubscription` or `support__add_internal_note`. Your policy service can match exact names, connection-wide patterns, roles, amounts, environments, or any other tenant-owned rule.

This policy evaluates every call. For approve-once behavior, check `ctx.approvedTools` explicitly after verifying the tenant.

## Apply it to an authored tool

Approval runs before `execute`. The executor must still derive and enforce tenancy again because approval is a gate, not authorization:

```ts title="agent/tools/transfer_funds.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { transferFunds } from "../../lib/payments";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineTool({
  description: "Transfer funds from the current tenant's account.",
  inputSchema: z.object({
    destinationAccountId: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
  approval: (ctx) => decideTenantApproval("tool", ctx),
  async execute(input, ctx) {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") {
      throw new Error("An authenticated tenant is required.");
    }

    return await transferFunds({
      ...input,
      tenantId,
      idempotencyKey: `${ctx.session.id}:${ctx.session.turn.id}`,
    });
  },
});
```

Use an application idempotency key for side effects. Human approval and replay safety solve different problems.

## Apply it to an OpenAPI connection

The same callback gates every generated operation. The qualified operation name lets tenant policy distinguish reads from writes:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineOpenAPIConnection({
  spec: "https://billing.example.com/openapi.json",
  description: "Billing operations for the authenticated tenant.",
  operations: { allow: ["listInvoices", "updateSubscription"] },
  headers: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") throw new Error("Tenant is required.");
    return {
      "X-Service-Token": process.env.BILLING_SERVICE_TOKEN!,
      "X-Tenant-Id": tenantId,
    };
  },
  approval: (ctx) => decideTenantApproval("connection", ctx),
});
```

The allow-list limits what the model can discover. Approval independently decides whether a discovered operation may run.

## Apply it to an MCP connection

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets for the authenticated tenant.",
  tools: { allow: ["search_tickets", "add_internal_note"] },
  headers: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") throw new Error("Tenant is required.");
    return {
      "X-Service-Token": process.env.SUPPORT_SERVICE_TOKEN!,
      "X-Tenant-Id": tenantId,
    };
  },
  approval: (ctx) => decideTenantApproval("connection", ctx),
});
```

The policy receives `connection:support__search_tickets` or `connection:support__add_internal_note` as its resource.

## Supply the policy adapter

The eve code needs only this interface:

```ts title="agent/lib/approval-policies.ts"
export interface ApprovalPolicyRequest {
  tenantId: string;
  userId: string;
  resource: string;
  input?: Record<string, unknown>;
}

export interface ApprovalPolicyDecision {
  decision: "allow" | "deny" | "require-approval";
  reason?: string;
}

export interface ApprovalPolicyProvider {
  decide(request: ApprovalPolicyRequest): Promise<ApprovalPolicyDecision>;
}

export { approvalPolicies } from "../../lib/approval-policies";
```

Implement membership, resource rules, roles, and thresholds in your application. Deny or throw on lookup failure, and recheck authorization inside side-effecting executors: membership or policy can change while a run is parked.

## Protect the approval response

An approval durably pauses the session and a later request resumes it. Your HTTP boundary must ensure a caller cannot continue or stream a session owned by another tenant. Persist session ownership in your application and check it before proxying:

- `POST /eve/v1/session/:sessionId`, including `inputResponses`;
- `GET /eve/v1/session/:sessionId/stream`.

Built-in approval confirms that a human with access to the session approved the call. To restrict who may respond, add an [approval response policy](/docs/human-in-the-loop#authorizing-approval-responses): it receives who responded as `response.principal` and who asked for the call as `request.principal`, and runs for both Approve and Cancel. For a four-eyes workflow, where a different person or role must approve, branch on `response.decision`: allow `cancel` so the requester can still withdraw the call, and for `approve` reject a `response.principal` that matches `request.principal` and check the responder's role.
