# Auto-AI API

Base URL: `http://localhost:8000/api/v1`

## Auth

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`

All authenticated endpoints require:

```text
Authorization: Bearer <jwt>
```

## Chats

- `GET /chats`
- `POST /chats`
- `GET /chats/{chat_id}`
- `PATCH /chats/{chat_id}`
- `DELETE /chats/{chat_id}`

## AI

- `POST /ai/chat` returns a full assistant message.
- `POST /ai/chat/stream` streams Server-Sent Events.
- `POST /ai/image-analysis` accepts an image upload and prompt.
- `POST /ai/code` supports `generate`, `debug`, and `explain`.

Streaming events use this shape:

```json
{"type":"delta","delta":"partial text"}
```

The final event is:

```json
{"type":"done","message_id":"..."}
```

## Documents

- `POST /documents/upload`
- `GET /documents`
- `GET /documents/{document_id}`
- `POST /documents/{document_id}/summarize`
- `DELETE /documents/{document_id}`

Supported formats: PDF, TXT, DOCX.

Upload responses include `file_size` and `document_metadata` with parser details such as `word_count`, `character_count`, `page_count` for PDFs, and the stored file hash.

## Voice

- `POST /voice/transcribe`

Supported formats: FLAC, MP3, M4A, MPEG, MPGA, OGG, WAV, WEBM.

## Human Mode

- `GET /human/profile` returns the user's adaptive interaction profile.
- `GET /human/state` returns profile, memories, and recent turn analyses.
- `GET /human/memories` lists user-owned memories. Optional query: `category`.
- `POST /human/memories` creates or upserts a memory.
- `PATCH /human/memories/{memory_id}` updates a memory.
- `DELETE /human/memories/{memory_id}` deletes a memory.
- `GET /human/turns` lists recent turn analyses. Optional queries: `chat_id`, `limit`.

Example memory payload:

```json
{
  "category": "communication_style",
  "key": "response_preference",
  "value": "prefers concise, code-first answers",
  "confidence": 0.9,
  "source": "user"
}
```

## Admin

- `GET /admin/stats`

The first registered user is made an admin. Additional admin users can be configured with `ADMIN_EMAILS`.
