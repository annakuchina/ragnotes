"""
RagNotes backend — FastAPI wrapper around the RAG pipeline.

Two main endpoints:
  POST /upload  — take a document, chunk it, embed it, store it
  POST /ask     — take a question, retrieve relevant chunks, generate an answer

Run with: uvicorn main:app --reload
Docs at: http://localhost:8000/docs
"""

from dotenv import load_dotenv
load_dotenv()

import os
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI, APIError, APITimeoutError, RateLimitError
from supabase import create_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ragnotes")

app = FastAPI(title="RagNotes API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # update once a frontend exists
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI()
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY"),
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class UploadRequest(BaseModel):
    source_document: str          # a name for this document, e.g. "week6_notes.txt"
    text: str                     # the actual document content


class UploadResponse(BaseModel):
    source_document: str
    chunks_stored: int


class AskRequest(BaseModel):
    question: str
    top_k: Optional[int] = 3      # how many chunks to retrieve


class AskResponse(BaseModel):
    answer: str
    sources: list[dict]           # the chunks that were actually used


# ---------------------------------------------------------------------------
# Core RAG functions (same logic as test_pipeline.py, now reused by the API)
# ---------------------------------------------------------------------------

def get_embedding(text: str) -> list[float]:
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text,
    )
    return response.data[0].embedding


def chunk_text(text: str, chunk_size: int = 300) -> list[str]:
    """Simple fixed-size chunking, by word count."""
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size):
        chunk = " ".join(words[i:i + chunk_size])
        chunks.append(chunk)
    return chunks


def store_chunk(content: str, source_document: str):
    embedding = get_embedding(content)
    supabase.table("document_chunks").insert({
        "content": content,
        "embedding": embedding,
        "source_document": source_document,
    }).execute()


def store_document(text: str, source_document: str, chunk_size: int = 300) -> int:
    # Replace any previously stored chunks from this same document,
    # so re-uploading doesn't create duplicates.
    supabase.table("document_chunks").delete().eq("source_document", source_document).execute()

    chunks = chunk_text(text, chunk_size)
    for chunk in chunks:
        store_chunk(chunk, source_document)

    return len(chunks)


def search_chunks(question: str, top_k: int = 3) -> list[dict]:
    question_embedding = get_embedding(question)
    response = supabase.rpc("match_chunks", {
        "query_embedding": question_embedding,
        "match_count": top_k,
    }).execute()
    return response.data


def generate_answer(question: str, chunks: list[dict]) -> str:
    context = "\n\n".join(
        f"[Source {i + 1}]: {chunk['content']}"
        for i, chunk in enumerate(chunks)
    )

    prompt = f"""Answer the question using ONLY the information in the sources below.
If the sources don't contain enough information to answer, say so clearly —
do not make up an answer from general knowledge.

When you use information from a source, cite it like this: [Source 1], [Source 2], etc.

Sources:
{context}

Question: {question}

Answer:"""

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    return {"status": "RagNotes backend is running"}


@app.post("/upload", response_model=UploadResponse)
def upload_document(body: UploadRequest):
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Document text cannot be empty")

    if len(body.text.strip()) < 100:
        raise HTTPException(
            status_code=400,
            detail="Document must be at least 100 characters to be useful for retrieval."
        )

    if not body.source_document.strip():
        raise HTTPException(status_code=400, detail="source_document name cannot be empty")

    try:
        chunks_stored = store_document(body.text, body.source_document)
    except Exception as e:
        logger.error(f"Failed to store document '{body.source_document}': {e}")
        raise HTTPException(status_code=500, detail="Failed to process and store document.")

    return UploadResponse(source_document=body.source_document, chunks_stored=chunks_stored)


@app.post("/upload-file", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """
    Accepts an actual uploaded file (.txt) instead of pasted text.
    Uses the filename as the source_document name.
    """
    if not file.filename.endswith(".txt"):
        raise HTTPException(
            status_code=400,
            detail="Only .txt files are supported right now."
        )

    raw_bytes = await file.read()

    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="Could not read file as text. Make sure it's a plain .txt file, not corrupted or a different format."
        )

    if not text.strip():
        raise HTTPException(status_code=400, detail="File is empty")

    if len(text.strip()) < 100:
        raise HTTPException(
            status_code=400,
            detail="Document must be at least 100 characters to be useful for retrieval."
        )

    try:
        chunks_stored = store_document(text, file.filename)
    except Exception as e:
        logger.error(f"Failed to store uploaded file '{file.filename}': {e}")
        raise HTTPException(status_code=500, detail="Failed to process and store document.")

    return UploadResponse(source_document=file.filename, chunks_stored=chunks_stored)


@app.post("/ask", response_model=AskResponse)
def ask_question(body: AskRequest):
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    try:
        chunks = search_chunks(body.question, top_k=body.top_k)
    except Exception as e:
        logger.error(f"Retrieval failed for question '{body.question}': {e}")
        raise HTTPException(status_code=500, detail="Failed to search stored documents.")

    if not chunks:
        return AskResponse(
            answer="No documents have been uploaded yet, so I have nothing to search. Upload a document first.",
            sources=[],
        )

    try:
        answer = generate_answer(body.question, chunks)
    except RateLimitError:
        raise HTTPException(status_code=502, detail="AI service is rate limited. Please try again shortly.")
    except (APITimeoutError, APIError) as e:
        logger.error(f"Generation failed for question '{body.question}': {e}")
        raise HTTPException(status_code=502, detail="Failed to generate an answer. Please try again.")

    return AskResponse(answer=answer, sources=chunks)
