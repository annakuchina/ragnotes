# Rag Notes

A RAG (Retrieval-Augmented Generation) app that answers questions using your own uploaded notes: not general AI knowledge. Upload a document, ask a question, and get an answer grounded in and cited from the actual content you provided. If your notes don't contain enough information to answer, it says so honestly instead of guessing.

## Stack

- **Python 3.14 / FastAPI** - async REST API
- **OpenAI API** - `text-embedding-3-small` for embeddings, `gpt-4o` for generation
- **Supabase (Postgres + pgvector)** - stores document chunks and their embeddings, performs similarity search directly in the database

## Architecture

```
Upload a document (pasted text or .txt file)
   │
   ├─ chunked into smaller pieces (~300 words each)
   ├─ each chunk embedded via OpenAI
   └─ stored in Supabase (document_chunks table, with pgvector)
       - re-uploading the same source_document replaces its old chunks

Ask a question
   │
   ├─ question embedded the same way
   ├─ Supabase's match_chunks function finds the closest chunks
   │     by cosine similarity, computed via pgvector
   ├─ top matches handed to gpt-4o along with the question
   └─ answer generated using ONLY the retrieved chunks, with citations
       - if nothing relevant was found, the model is instructed to say so
       rather than answer from general knowledge
```

## Key design decisions

**Retrieval happens in the database, not in application code.**
A Postgres function (`match_chunks`) does the cosine similarity comparison directly via pgvector's `<=>` operator, rather than pulling every embedding into Python and comparing manually. This is the same underlying math as comparing two embeddings by hand, but it scales - comparing against thousands of stored chunks inside the database is far more efficient than doing it row-by-row in application code.

**Generation is explicitly instructed to stay grounded, not just retrieve-then-ask.**
The prompt given to the model doesn't just include the retrieved chunks - it explicitly instructs the model to answer _only_ from the provided sources, to cite which source supports each claim, and to say so clearly if the sources don't contain enough information rather than falling back on general knowledge. This is tested directly in the eval suite: a question with no relevant uploaded content correctly produces an honest "I don't have enough information" response rather than a hallucinated answer.

**Re-uploading a document replaces its chunks instead of duplicating them.**
`store_document` deletes any existing chunks tagged with the same `source_document` name before inserting new ones. Without this, re-processing the same document would accumulate duplicate chunks indefinitely, degrading retrieval quality over time as identical content piled up.

**Access control via Supabase Row Level Security.**
The database has RLS enabled by default, requiring explicit `GRANT` statements for each type of operation (`select`, `insert`, `delete`) the backend needs, rather than the table being openly readable/writable by default. This follows the same principle applied elsewhere: default to denying access, and grant only what's actually needed.

**Fixed-size chunking as a deliberate starting point, not the final word.**
Documents are split into ~300-word chunks with no overlap and no awareness of paragraph or sentence boundaries. This is the simplest reasonable chunking strategy, and a known trade-off - see Limitations below.

## Eval suite

`eval/` contains automated test cases run against the live API (not mocked), covering:

- Correct retrieval and generation on two different topics
- **Retrieval discrimination** - with multiple unrelated documents stored, confirms a question about one topic doesn't pull in the other
- **Honest uncertainty** - confirms a question with no relevant stored content produces a low-confidence response instead of a hallucinated one
- Input validation on both `/upload` (empty, too-short text) and `/ask` (empty question)

Run with:

```bash
uvicorn main:app --reload &     # in one terminal
cd eval && python run_eval.py   # in another
```

Current result: 7/7 passing. As with any eval suite, this covers a specific, bounded set of scenarios rather than proving the system handles all input well: it's a fast way to check whether a change to the prompt, chunking strategy, or model made retrieval or generation better or worse.

## Known limitations

- **Fixed-size chunking can split relevant context across chunk boundaries.** A 300-word cutoff has no awareness of sentence or paragraph structure, so information that spans a boundary could end up split between two chunks, weakening the match for a question that needs both halves.
- **No chunk overlap.** A common mitigation for boundary-splitting is to overlap adjacent chunks slightly; this implementation doesn't.
- **Only `.txt` files are supported for direct file upload.** PDF and other formats would need a text-extraction step first.
- **Document identity is just a filename string.** Two different documents with the same name would overwrite each other; there's no deduplication based on actual content.
- **No evaluation of generation quality beyond keyword presence.** The eval suite checks whether expected keywords appear and whether retrieval picked the right source, but doesn't independently score answer coherence or completeness.
- **Single-user.** All uploaded documents are stored in one shared table with no per-user separation - this is a personal tool, not a multi-tenant product, by design at this stage.

## What I'd change at scale

- Chunk by paragraph or sentence boundaries instead of a fixed word count, with slight overlap between adjacent chunks
- Support PDF upload with a text-extraction step
- Add per-user document isolation if this became multi-user
- Track retrieval quality and generation quality as separate metrics, rather than one combined pass/fail per eval case
- Cache embeddings for identical re-uploaded content to avoid redundant API calls

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install fastapi "uvicorn[standard]" openai python-dotenv supabase numpy python-multipart
```

Add to `.env`:

```
OPENAI_API_KEY=your-openai-key
SUPABASE_URL=your-supabase-project-url
SUPABASE_SERVICE_KEY=your-supabase-service-role-key
```

Requires a Supabase project with the `pgvector` extension enabled, a `document_chunks` table, and a `match_chunks` Postgres function (see below).

Run:

```bash
uvicorn main:app --reload
```

API at `http://localhost:8000`, docs at `http://localhost:8000/docs`.

## Database setup (Supabase SQL)

```sql
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536),
  source_document text,
  created_at timestamp with time zone default now()
);

create or replace function match_chunks (
  query_embedding vector(1536),
  match_count int default 3
)
returns table (
  id uuid,
  content text,
  source_document text,
  similarity float
)
language sql stable
as $$
  select id, content, source_document, 1 - (embedding <=> query_embedding) as similarity
  from document_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant select, insert, delete on public.document_chunks to service_role;
```

## Endpoints

| Method | Path           | Description                                  |
| ------ | -------------- | -------------------------------------------- |
| GET    | `/`            | Health check                                 |
| POST   | `/upload`      | Upload a document as pasted text             |
| POST   | `/upload-file` | Upload a document as a `.txt` file           |
| POST   | `/ask`         | Ask a question, get a grounded, cited answer |
