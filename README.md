# OpenAI Agents SDK TypeScript Project

A TypeScript/Node.js project that ports functionality from the Python `ship-RAG-ai` project to use [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/). This project provides chat functionality with security checks, vector search, SQL query generation, and CSV generation for large result sets.

## Features

- **Chat API**: Natural language to SQL query generation with OpenAI Agents SDK
- **Vector Search**: Semantic search using Hugging Face embeddings and PostgreSQL pgvector
- **Security Checks**: Query validation for non-admin users
- **CSV Generation**: Automatic CSV generation for large result sets (>5 rows)
- **Token Tracking**: Comprehensive token usage tracking per request and stage
- **Structured Logging**: Winston-based logging with request context

## Tech Stack

- **TypeScript**: Type-safe development
- **Express**: Web framework
- **Sequelize**: PostgreSQL ORM
- **OpenAI Agents SDK**: Agent orchestration and LLM integration
- **Hugging Face Transformers**: Embedding generation
- **PostgreSQL + pgvector**: Vector storage and search

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ with pgvector extension
- OpenAI API key

### Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
```env
OPENAI_API_KEY=your_openai_api_key
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_user
DB_PASSWORD=your_password
EMBEDDING_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
```

4. Build the project:
```bash
npm run build
```

5. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

### POST /chat
Chat endpoint for natural language questions.

**Request:**
```json
{
  "token_id": "Test123",
  "question": "How many devices are there?",
  "user_id": "user123"
}
```

**Response:**
```json
{
  "token_id": "Test123",
  "answer": "There are 42 devices.",
  "sql_query": "SELECT COUNT(*) FROM device_details_table...",
  "csv_id": "uuid-if-large-result",
  "csv_download_path": "/download-csv/uuid"
}
```

### POST /vector-search
Search for similar examples in vector store.

### POST /generate-embeddings
Generate embeddings for examples.

### GET /download-csv/:csvId
Download CSV file by ID.

### GET /health
Health check endpoint.

## Project Structure

```
open-ai-sdk/
├── src/
│   ├── config/          # Configuration (database, settings)
│   ├── services/        # Core services (vector store, embeddings, database)
│   ├── agents/          # Agent setup and tools
│   ├── controllers/     # Request handlers
│   ├── routes/          # API routes
│   ├── utils/           # Utilities (CSV, logging, token tracking)
│   ├── models/          # Sequelize models and TypeScript interfaces
│   └── app.ts           # Express application setup
├── package.json
├── tsconfig.json
└── .env.example
```

## Key Differences from Python Project

1. **Simpler Structure**: Removed complex LangGraph state management
2. **OpenAI Only**: No Groq fallback logic needed
3. **OpenAIConversationsSession**: Better token management
4. **TypeScript Types**: Strong typing throughout
5. **Sequelize ORM**: Type-safe database models
6. **Improved Logging**: Structured JSON logging with request context

## License

ISC
