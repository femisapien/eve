---
title: "Responsible Use"
description: "Deployer responsibility and safeguards to review before using eve with sensitive, regulated, or production data."
---

As the deployer, you are responsible for legal compliance and for configuring safeguards appropriate to your use case: approval policies, tool and connection scopes, route and session authorization, sandbox controls, and telemetry exports.

Before handling sensitive, regulated, or production data, review every action available to the agent, including default and custom tools, connections, shell and web access, subagents, and schedules.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.
