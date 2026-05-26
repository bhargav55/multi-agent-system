# Build Portfolio Knowledge Assistant

## Context

The portfolio needs a production chatbot backed by a knowledge base. The chatbot should answer questions about experience, projects, resume, and protocol work.

## Research Notes

- Static websites cannot safely store provider secrets.
- The backend must own OpenAI/Anthropic credentials.
- Retrieval should be scoped by tenant and site.

## Requirements

- Add a browser-safe knowledge assistant endpoint.
- Ingest portfolio and resume content into the knowledge base.
- Wire the frontend chatbot to the deployed endpoint.

## Acceptance Criteria

- The chatbot answers questions about Nunchi experience.
- Answers include citations or source references.
- No provider API key is exposed in frontend code.

## Out of Scope

- Billing.
- Admin dashboard.
- Public analytics UI.
