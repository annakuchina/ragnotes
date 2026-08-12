"""
Eval cases for RagNotes.

Each case uploads a document, asks a question about it, and checks that:
- retrieval found the right document (not an unrelated one)
- the answer contains expected keywords
- edge cases (empty input, no documents, irrelevant questions) are handled gracefully
"""

EVAL_CASES = [
    {
        "name": "upload_and_retrieve_science_topic",
        "upload_text": "Photosynthesis is the process by which plants, algae, and some bacteria convert light energy into chemical energy. It occurs primarily in the chloroplasts of plant cells, using a pigment called chlorophyll which absorbs light, mostly in the blue and red wavelengths. The process uses carbon dioxide from the air and water absorbed by the roots, producing glucose and oxygen as a byproduct.",
        "source_document": "eval_photosynthesis",
        "question": "What pigment absorbs light in photosynthesis?",
        "expect_keywords": ["chlorophyll"],
        "expect_min_similarity": 0.3,
    },
    {
        "name": "upload_and_retrieve_history_topic",
        "upload_text": "The French Revolution began in 1789 and fundamentally transformed France's political and social structure. It was driven by frustration with the absolute monarchy under King Louis XVI, financial crisis from war debts, and inequality between the nobility and the Third Estate. The storming of the Bastille on July 14, 1789 became a symbolic turning point.",
        "source_document": "eval_french_revolution",
        "question": "What happened at the Bastille?",
        "expect_keywords": ["Bastille"],
        "expect_min_similarity": 0.3,
    },
    {
        "name": "retrieval_discriminates_between_documents",
        "question": "What caused the French Revolution?",
        "expect_keywords": ["Louis XVI", "monarchy"],
        "expect_not_source": "eval_photosynthesis",
        "skip_upload": True,
    },
    {
        "name": "question_with_no_relevant_documents",
        "question": "What is the capital of Mongolia?",
        "expect_low_confidence": True,
        "skip_upload": True,
    },
    {
        "name": "empty_upload_text",
        "upload_text": "",
        "source_document": "eval_empty",
        "expect_upload_error": True,
    },
    {
        "name": "too_short_upload_text",
        "upload_text": "Too short.",
        "source_document": "eval_short",
        "expect_upload_error": True,
    },
    {
        "name": "empty_question",
        "question": "",
        "expect_ask_error": True,
        "skip_upload": True,
    },
]
