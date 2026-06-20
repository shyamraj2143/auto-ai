# Auto-AI Architecture

## Project Layout

```text
/frontend   React, TypeScript, Tailwind CSS, chat UI
/backend    FastAPI app, AI provider integration, auth, persistence
/database   SQLite runtime data and database notes
/docs       Architecture and API documentation
/docker     Docker Compose entrypoint
```

## Backend

FastAPI exposes versioned APIs under `/api/v1`. JWT authentication protects all assistant, document, voice, and admin endpoints. Passwords are hashed with bcrypt via Passlib. SQLite is accessed through SQLAlchemy models and repository classes.

Core modules:

- `app/core`: configuration, JWT/password security, rate limiting
- `app/db`: SQLAlchemy engine/session/bootstrap
- `app/models`: user, chat, message, document, API usage tables
- `app/services`: OpenAI/Groq API calls and document extraction/summarization
- `app/api/routes`: auth, chat, AI, documents, voice, admin, health endpoints

## Ultra Human Mode

The adaptive conversation layer lives in `backend/app/services/human`. It runs before each chat completion and after each assistant response.

Modules:

- Emotion detection, tone analysis, and style mirroring
- Emotional state scoring for trust, rapport, respect, curiosity, confidence, frustration, and humor
- Long-term user-owned memory extraction and retrieval
- Personality adaptation across mentor, engineer, researcher, friend, teacher, strategist, and creative thinker modes
- Relationship tracking for topics, projects, goals, and learning style
- Conversation flags for repetition, circularity, urgency, identity probes, and contradiction signals
- Prompt humanization that injects compact adaptive context into Groq calls

Persistent tables:

- `user_interaction_profiles`
- `user_memories`
- `conversation_turn_analyses`

The public API surface is exposed under `/api/v1/human`. Full details are in `docs/human-mode.md`.

## AI Provider Integration

Auto-AI can use OpenAI, Groq, or Amazon Bedrock-compatible chat completions. The active chat provider is selected with `AI_PROVIDER`.

- OpenAI chat completions with `gpt-4.1-mini`
- Groq chat completions with `openai/gpt-oss-120b`
- Streaming token output through Server-Sent Events

Groq-specific optional capabilities include:

- Web-search mode with `groq/compound-mini`
- Vision analysis with a configurable multimodal Groq model
- Speech-to-text with `whisper-large-v3-turbo`

The default model values are environment-driven and can be changed without code edits.

## Frontend

React Router separates the public landing page, auth, chat workspace, and admin views. Context API manages authentication, theme, and chat state. The chat screen streams assistant output, renders Markdown, highlights code, virtualizes long threads by showing the latest messages, provides message actions, supports a unified text/file/image/voice composer, exposes document context, and includes a memory management panel.

## MongoDB Readiness

The application currently ships with SQLite as requested. Repositories in `backend/app/repositories` define the data access seam. A MongoDB adapter can implement the same repository methods while preserving API, schema, and service behavior.
