"""
RagNotes backend, FastAPI wrapper around the RAG pipeline.

Documents are scoped by session_id, a random ID generated and stored in
each browser's localStorage. This is lightweight isolation for a demo,
NOT real authentication. There's no password, no account, and a
session_id can be read or spoofed by anyone with browser dev tools. Real
auth (Supabase Auth + JWT verification) was already demonstrated in a
separate project; this project's focus is retrieval, not auth.

Main endpoints:
  POST   /upload              take pasted text, chunk it, embed it, store it
  POST   /upload-file         take an uploaded .txt file, chunk it, embed it, store it
  GET    /documents           list a session's uploaded documents
  DELETE /documents/{name}    delete a document and all its chunks, scoped to a session
  POST   /ask                 take a question, retrieve relevant chunks (scoped to a session), generate an answer

Run with: uvicorn main:app --reload
Docs at: http://localhost:8000/docs
"""

from dotenv import load_dotenv
load_dotenv()

import os
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI, APIError, APITimeoutError, RateLimitError
from supabase import create_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ragnotes")

app = FastAPI(title="RagNotes API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI()
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY"),
)


def get_session_id(x_session_id: Optional[str] = Header(None)) -> str:
    if not x_session_id or not x_session_id.strip():
        raise HTTPException(status_code=400, detail="Missing X-Session-Id header.")
    return x_session_id.strip()


class UploadRequest(BaseModel):
    source_document: str
    text: str


class UploadResponse(BaseModel):
    source_document: str
    chunks_stored: int
    replaced: bool


class AskRequest(BaseModel):
    question: str
    top_k: Optional[int] = 3


class AskResponse(BaseModel):
    answer: str
    sources: list[dict]


class DocumentsResponse(BaseModel):
    documents: list[str]


def get_embedding(text: str) -> list[float]:
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text,
    )
    return response.data[0].embedding


def chunk_text(text: str, chunk_size: int = 300) -> list[str]:
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size):
        chunk = " ".join(words[i:i + chunk_size])
        chunks.append(chunk)
    return chunks


def store_chunk(content: str, source_document: str, session_id: str):
    embedding = get_embedding(content)
    supabase.table("document_chunks").insert({
        "content": content,
        "embedding": embedding,
        "source_document": source_document,
        "session_id": session_id,
    }).execute()


def store_document(text: str, source_document: str, session_id: str, chunk_size: int = 300) -> dict:
    existing = supabase.table("document_chunks") \
        .select("id") \
        .eq("source_document", source_document) \
        .eq("session_id", session_id) \
        .limit(1) \
        .execute()
    replaced = len(existing.data) > 0

    supabase.table("document_chunks").delete() \
        .eq("source_document", source_document) \
        .eq("session_id", session_id) \
        .execute()

    chunks = chunk_text(text, chunk_size)
    for chunk in chunks:
        store_chunk(chunk, source_document, session_id)

    return {"chunks_stored": len(chunks), "replaced": replaced}


def delete_document(source_document: str, session_id: str):
    supabase.table("document_chunks").delete() \
        .eq("source_document", source_document) \
        .eq("session_id", session_id) \
        .execute()


def list_documents(session_id: str) -> list[str]:
    result = supabase.table("document_chunks") \
        .select("source_document") \
        .eq("session_id", session_id) \
        .execute()
    seen = []
    for row in result.data:
        name = row["source_document"]
        if name not in seen:
            seen.append(name)
    return seen


def search_chunks(question: str, session_id: str, top_k: int = 3) -> list[dict]:
    question_embedding = get_embedding(question)
    response = supabase.rpc("match_chunks", {
        "query_embedding": question_embedding,
        "match_count": top_k,
        "filter_session_id": session_id,
    }).execute()
    return response.data


def generate_answer(question: str, chunks: list[dict]) -> str:
    context = "\n\n".join(
        f"[Source {i + 1}]: {chunk['content']}"
        for i, chunk in enumerate(chunks)
    )

    prompt = f"""Answer the question using ONLY the information in the sources below.
If the sources don't contain enough information to answer, say so clearly,
do not make up an answer from general knowledge.

Be specific: include exact dates, numbers, names, or other precise details
from the sources when they're relevant to the question, rather than giving
only a general summary.

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


@app.get("/")
def root():
    return {"status": "RagNotes backend is running"}


@app.post("/upload", response_model=UploadResponse)
def upload_document(body: UploadRequest, session_id: str = Header(None, alias="X-Session-Id")):
    session_id = get_session_id(session_id)

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
        result = store_document(body.text, body.source_document, session_id)
    except Exception as e:
        logger.error(f"Failed to store document '{body.source_document}': {e}")
        raise HTTPException(status_code=500, detail="Failed to process and store document.")

    return UploadResponse(source_document=body.source_document, chunks_stored=result["chunks_stored"], replaced=result["replaced"])


@app.post("/upload-file", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...), session_id: str = Header(None, alias="X-Session-Id")):
    session_id = get_session_id(session_id)

    if not file.filename.endswith(".txt"):
        raise HTTPException(status_code=400, detail="Only .txt files are supported right now.")

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
        result = store_document(text, file.filename, session_id)
    except Exception as e:
        logger.error(f"Failed to store uploaded file '{file.filename}': {e}")
        raise HTTPException(status_code=500, detail="Failed to process and store document.")

    return UploadResponse(source_document=file.filename, chunks_stored=result["chunks_stored"], replaced=result["replaced"])


@app.get("/documents", response_model=DocumentsResponse)
def get_documents(session_id: str = Header(None, alias="X-Session-Id")):
    session_id = get_session_id(session_id)
    try:
        docs = list_documents(session_id)
    except Exception as e:
        logger.error(f"Failed to list documents for session: {e}")
        raise HTTPException(status_code=500, detail="Failed to list documents.")
    return DocumentsResponse(documents=docs)


@app.delete("/documents/{source_document}")
def remove_document(source_document: str, session_id: str = Header(None, alias="X-Session-Id")):
    session_id = get_session_id(session_id)
    try:
        delete_document(source_document, session_id)
    except Exception as e:
        logger.error(f"Failed to delete document '{source_document}': {e}")
        raise HTTPException(status_code=500, detail="Failed to delete document.")

    return {"status": "deleted", "source_document": source_document}


@app.post("/ask", response_model=AskResponse)
def ask_question(body: AskRequest, session_id: str = Header(None, alias="X-Session-Id")):
    session_id = get_session_id(session_id)

    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    try:
        chunks = search_chunks(body.question, session_id, top_k=body.top_k)
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
