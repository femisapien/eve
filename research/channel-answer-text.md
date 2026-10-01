---
issue: https://github.com/vercel/eve/pull/4140
status: in-progress
last_updated: "2026-10-01"
---

# Channel reply text for pending questions

> **AI status:** Written entirely by AI; human review pending.

Slack wraps messages with sender metadata and thread history. Matching that
model-visible envelope against a pending question either misses an option or
accepts the envelope as free text. Moving the envelope into context fixes
matching but changes every ordinary Slack turn and duplicates its text.

## API and semantics

```ts
await from(threadId).send(attributedMessage, {
  auth,
  answerText: personText,
});
```

`ChannelSendOptions.answerText?: string` reaches `DeliverPayload.answerText`.
Core uses it instead of `message` when resolving a string message against the
only pending question, or an eligible approval batch. Omission retains direct message matching. An empty string
does not fall back to the envelope. Missing or multipart messages, delegated
deliveries, ambiguous questions, and explicit input responses retain their
existing behavior.

Existing approval matching also carries this field through channel delivery,
batching, and deferred harness input. Its eligibility rules remain unchanged:
requests with response policies are excluded from text matching, and proxied
approvals still need structured responses. This repairs formatted channels rather
than adding new ways to approve tools.

The field does not reach the model. Ordinary Slack message envelopes, fetched
thread history, authored context, and attachments remain unchanged. Core does
not parse Slack markup or call channel delivery hooks early.

A consumed answer drops `message`, `answerText`, `context`, and channel `state`
together. Its tool receives the answer and available responder identity; metadata
is not persisted separately or delivered to the parent. This avoids steering a
waiting turn or starting a parked turn without introducing history-only delivery.
Unrelated payload fields and unmatched deliveries remain unchanged.
