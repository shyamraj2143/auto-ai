# Auto-AI

Auto-AI is a premium AI workspace built with React, TypeScript, Tailwind CSS, Framer Motion, GSAP, FastAPI, SQLite-ready persistence, JWT authentication, and selectable OpenAI, Groq, or Amazon Bedrock chat providers.

## Features

- Commercial landing page with animated product preview, feature sections, testimonials, pricing, FAQ, and footer
- Glassmorphism chat workspace with streaming output, thinking animation, typing cursor, and smooth message transitions
- Unified composer for text, PDF, DOCX, TXT, image upload, voice input, model selection, web search, reasoning, and send
- Upload progress, drag and drop, previews, readable errors, document metadata, and selected-document context
- Message actions: copy, reactions, regenerate, edit prompt, continue response, bookmark, share, and read aloud
- Personal memory panel for saved preferences, project notes, adaptive profile scores, and memory deletion
- Ultra Human Mode adaptive conversation layer with emotion, tone, memory, personality, relationship, and style engines
- JWT login/register/logout, persistent chats and messages, admin dashboard, and Docker support
- Web search through Groq Compound, image analysis through Groq vision, and speech-to-text through Groq audio

## Requirements

- Python 3.12+
- Node.js 20+
- An OpenAI, Groq, or Amazon Bedrock API key

## Setup

1. Copy environment variables:

```bash
cp .env.example .env
```

2. Set `AI_PROVIDER=groq` and `GROQ_API_KEY` in `.env`, or select OpenAI/Bedrock and configure `AUTO_AI_OPENAI_API_KEY` or `BEDROCK_API_KEY`.

3. Start the backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

4. Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

5. Open:

```text
http://localhost:5173
```

The first registered user becomes an admin automatically.

## Docker

From the project root:

```bash
cp .env.example .env
docker compose up --build
```

Frontend: `http://localhost:5173`

Backend health: `http://localhost:8000/api/v1/health`

## Configuration

Important environment variables:

- `AI_PROVIDER`: chat provider, `openai`, `groq`, or `bedrock`
- `AUTO_AI_OPENAI_API_KEY`: project-specific OpenAI API key
- `OPENAI_MODEL`: OpenAI chat model, default `gpt-4.1-mini`
- `GROQ_API_KEY`: Groq API key
- `GROQ_MODEL`: Groq chat model, default `openai/gpt-oss-120b`
- `GROQ_SEARCH_MODEL`: Groq search-capable model, default `groq/compound-mini`
- `GROQ_VISION_MODEL`: Groq image analysis model
- `GROQ_AUDIO_MODEL`: Groq transcription model
- `BEDROCK_API_KEY`: Amazon Bedrock API key
- `BEDROCK_REGION`: Amazon Bedrock runtime region, default `us-east-1`
- `BEDROCK_MODEL`: Bedrock chat model, default `openai.gpt-oss-120b`
- `BEDROCK_ENDPOINT_MODE`: Bedrock endpoint mode, `mantle`, `runtime`, or `auto`; default `mantle`
- `SECRET_KEY`: JWT signing secret
- `SQLITE_PATH`: SQLite database path
- `BACKEND_CORS_ORIGINS`: frontend origins allowed by FastAPI
- `MAX_UPLOAD_MB`: max upload size for documents, images, and voice
- `VITE_API_URL`: frontend API base URL. For mobile/public deployments, use a public HTTPS URL, not `localhost`.

## Notes

SQLite is the active database for this build. Repository boundaries keep the persistence layer isolated so a MongoDB adapter can be added without changing route contracts.

See `docs/human-mode.md` for the adaptive conversation architecture, database schema, APIs, prompts, and memory design.
