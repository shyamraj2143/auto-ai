# Auto-AI

Auto-AI is a ChatGPT-style AI assistant built with React, TypeScript, Tailwind CSS, FastAPI, SQLite, JWT authentication, and selectable OpenAI, Groq, or Amazon Bedrock chat providers.

## Features

- ChatGPT-style chat interface with sidebar history
- Per-message OpenAI/Groq/Bedrock provider and model selection
- Light and dark modes
- Streaming OpenAI or Groq responses, with Bedrock responses returned through the same chat stream flow
- Markdown rendering, syntax highlighting, and copyable code blocks
- JWT login/register/logout
- Persistent chats and messages
- PDF, TXT, and DOCX upload with AI summaries
- Chat with selected uploaded documents
- Browser voice input with Groq speech-to-text
- Browser text-to-speech for assistant messages
- Ultra Human Mode adaptive conversation layer with emotion, tone, memory, personality, and relationship engines
- User-owned memory APIs for inspectable, editable long-term personalization
- Web search mode through Groq Compound
- Image analysis through a configurable Groq vision model
- Code generation, debugging, and explanation endpoint
- Admin dashboard with usage and system stats
- Docker support

## Requirements

- Python 3.12+
- Node.js 20+
- An OpenAI, Groq, or Amazon Bedrock API key

## Setup

1. Copy environment variables:

```bash
cp .env.example .env
```

2. Set `AI_PROVIDER=bedrock` and `BEDROCK_API_KEY` in `.env`, or select OpenAI/Groq and configure `AUTO_AI_OPENAI_API_KEY` or `GROQ_API_KEY`.

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

Or from the `docker` folder:

```bash
cd docker
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
- `BEDROCK_REGION`: Amazon Bedrock runtime region, default `us-south-1`
- `BEDROCK_MODEL`: Bedrock chat model, default `openai.gpt-oss-120b`
- `BEDROCK_ENDPOINT_MODE`: Bedrock endpoint mode, `mantle`, `runtime`, or `auto`; default `mantle`
- `BEDROCK_MANTLE_BASE_URL`: optional Bedrock Mantle base URL override
- `BEDROCK_AUTH_MODE`: Bedrock auth mode, `auto`, `api_key`, or `aws`; default `auto`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`: optional SigV4 fallback credentials for Bedrock
- `SECRET_KEY`: JWT signing secret
- `SQLITE_PATH`: SQLite database path
- `BACKEND_CORS_ORIGINS`: frontend origins allowed by FastAPI

## Notes

SQLite is the active database for the initial build. The backend keeps persistence isolated in repository classes so a MongoDB adapter can be added without changing route contracts.

See `docs/human-mode.md` for the adaptive conversation architecture, database schema, APIs, prompts, and memory design.

Provider endpoints used by this build:

- OpenAI Chat Completions endpoint: `https://api.openai.com/v1/chat/completions`
- Chat completions endpoint: `https://api.groq.com/openai/v1/chat/completions`
- OpenAI-compatible Groq API base URL: `https://api.groq.com/openai/v1`
- Amazon Bedrock Mantle Chat Completions endpoint: `https://bedrock-mantle.{region}.api.aws/v1/chat/completions`
- Amazon Bedrock Converse endpoint: `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse`

Bedrock uses the Mantle Chat Completions endpoint by default because AWS recommends it for OpenAI-compatible chat. If the native runtime endpoint returns `Operation not allowed`, the key/role can read account model metadata but cannot invoke runtime models; enable Bedrock model invocation permissions such as `bedrock:InvokeModel`/Converse for the selected model and region or keep `BEDROCK_ENDPOINT_MODE=mantle`.
