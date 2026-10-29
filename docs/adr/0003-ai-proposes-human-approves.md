# ADR-0003: AI can propose changes, but a person performs Approve

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

AI can prepare useful Task, link, Skill, schema, and Knowledge changes. Those changes cross permissions and can affect shared Workspace data, so a provider call or credential must not be able to mutate the system by itself.

## Decision

AI has read and propose capabilities only. It can assemble a complete Proposal, but it has no write or `apply_proposal` capability. A person reviews the Proposal and triggers Approve through an authenticated web session. Approval is one explicit human action for the selected Proposal contents; tokens, MCP clients, provider callbacks, and AI tools cannot Approve. The server validates the Proposal against the initiator's access and selected scope before applying it.

## Alternatives considered

- **Give AI direct write capabilities for individual records.** Rejected because it bypasses the shared Proposal review and approval boundary, making changes harder to inspect and undo as a group.
- **Allow AI or an integration token to call Approve.** Rejected because credentials and provider activity are not a person's deliberate review action.
- **Use pre-authorized policies or hidden batches for routine changes.** Rejected because changes could be applied without the approver seeing the complete set that takes effect.
- **Require separate approval for every item.** Rejected because one Proposal is the review and apply unit; splitting approval would permit a partial plan and dangling dependencies.

## Consequences

AI workflows end at a Ready Proposal. The web approval path is the only apply authority, and the complete Proposal, reasons, sources, and changes must be available to the person before Approve.
