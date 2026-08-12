"""
Step 1 test: prove the full pipeline works end to end.

1. Take a piece of text, split it into chunks
2. Embed each chunk
3. Store each chunk + its embedding in Supabase
4. Ask a question, embed it, search Supabase for the closest chunks
5. Print what it found

Run with: python test_pipeline.py
"""

from dotenv import load_dotenv
load_dotenv()

import os
from openai import OpenAI
from supabase import create_client

client = OpenAI()
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY"),
)


def get_embedding(text: str) -> list[float]:
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text,
    )
    return response.data[0].embedding


def chunk_text(text: str, chunk_size: int = 300) -> list[str]:
    """
    Very simple chunking: split into pieces of roughly `chunk_size` words each.
    Not fancy — good enough as a starting point.
    """
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size):
        chunk = " ".join(words[i:i + chunk_size])
        chunks.append(chunk)
    return chunks


def store_chunk(content: str, source_document: str):
    """Embed a single chunk and store it in Supabase."""
    embedding = get_embedding(content)
    supabase.table("document_chunks").insert({
        "content": content,
        "embedding": embedding,
        "source_document": source_document,
    }).execute()


def store_document(text: str, source_document: str, chunk_size: int = 300):
    """
    Chunk a document and store it, replacing any previously stored chunks
    from the same source_document first — so re-running this on the same
    document doesn't pile up duplicates.
    """
    # Remove any old chunks from this same document first
    supabase.table("document_chunks").delete().eq("source_document", source_document).execute()

    chunks = chunk_text(text, chunk_size)
    for chunk in chunks:
        store_chunk(chunk, source_document)

    return len(chunks)


def search_chunks(question: str, top_k: int = 3):
    """
    Embed the question, then ask Supabase to find the closest chunks
    using pgvector's built-in similarity search.
    """
    question_embedding = get_embedding(question)

    # This calls a Postgres function we need to create in Supabase first
    # (see match_chunks SQL below) — it does the cosine similarity
    # comparison directly in the database, instead of pulling everything
    # into Python and comparing manually like the rag_demo.py script did.
    response = supabase.rpc("match_chunks", {
        "query_embedding": question_embedding,
        "match_count": top_k,
    }).execute()

    return response.data


def generate_answer(question: str, chunks: list[dict]) -> str:
    """
    This is the 'generation' half of RAG — the part we haven't built yet.
    Take the retrieved chunks and the question, hand them both to the AI,
    and ask it to answer using ONLY the provided material, citing which
    chunk each part of the answer came from.
    """
    # Build a numbered list of the retrieved chunks, so the AI can cite
    # them by number in its answer.
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


if __name__ == "__main__":
    # --- Step 1: store a test document ---
    sample_text = """
    Photosynthesis is the process by which plants, algae, and some bacteria
    convert light energy into chemical energy. It occurs primarily in the
    chloroplasts of plant cells, using a pigment called chlorophyll which
    absorbs light, mostly in the blue and red wavelengths.

    The process uses carbon dioxide from the air and water absorbed by the
    roots, producing glucose and oxygen as a byproduct. Photosynthesis has
    two main stages: the light-dependent reactions, which occur in the
    thylakoid membrane and produce ATP and NADPH, and the light-independent
    reactions (Calvin cycle), which occur in the stroma and use that ATP
    and NADPH to build glucose from carbon dioxide.
    """

    print("Storing document (replaces any previous chunks from this same document)...")
    num_chunks = store_document(sample_text, source_document="photosynthesis_notes.txt", chunk_size=50)
    print(f"Stored {num_chunks} chunk(s)\n")

    print("\nSearching for a relevant chunk...")
    question = "What does chlorophyll do?"
    print(f"Question: {question}\n")

    results = search_chunks(question, top_k=2)

    print("Top matches:")
    for r in results:
        print(f"  (similarity: {r['similarity']:.4f}) {r['content'][:100]}...")

    print("\nGenerating an answer grounded in those chunks...\n")
    answer = generate_answer(question, results)
    print(f"Answer: {answer}")
