"""
Runs the eval cases in eval_cases.py against a running RagNotes backend.

Usage:
    1. Make sure the backend is running: uvicorn main:app --reload
    2. From the ragnotes folder, run: python run_eval.py
"""

import requests
from eval_cases import EVAL_CASES

BACKEND_URL = "http://localhost:8000"


def check_case(case: dict) -> tuple[bool, str]:
    if not case.get("skip_upload"):
        upload_response = requests.post(
            f"{BACKEND_URL}/upload",
            json={
                "source_document": case["source_document"],
                "text": case["upload_text"],
            },
            timeout=60,
        )

        if case.get("expect_upload_error"):
            if upload_response.status_code == 400:
                return True, "upload correctly rejected with 400"
            return False, f"expected upload to fail with 400, got {upload_response.status_code}"

        if upload_response.status_code != 200:
            return False, f"upload failed unexpectedly: {upload_response.status_code}: {upload_response.text[:200]}"

    if "question" not in case:
        return True, "upload behaved as expected"

    ask_response = requests.post(
        f"{BACKEND_URL}/ask",
        json={"question": case["question"]},
        timeout=60,
    )

    if case.get("expect_ask_error"):
        if ask_response.status_code == 400:
            return True, "question correctly rejected with 400"
        return False, f"expected ask to fail with 400, got {ask_response.status_code}"

    if ask_response.status_code != 200:
        return False, f"ask failed unexpectedly: {ask_response.status_code}: {ask_response.text[:200]}"

    data = ask_response.json()
    answer = data.get("answer", "")
    sources = data.get("sources", [])

    if case.get("expect_low_confidence"):
        low_confidence_signals = ["don't have", "no information", "not contain",
                                    "cannot answer", "insufficient", "no documents"]
        if any(signal in answer.lower() for signal in low_confidence_signals):
            return True, f"correctly signaled low confidence: \"{answer[:100]}\""
        return False, f"expected a low-confidence response, got: \"{answer[:150]}\""

    if case.get("expect_keywords"):
        missing = [kw for kw in case["expect_keywords"] if kw.lower() not in answer.lower()]
        if missing:
            return False, f"answer missing expected keywords {missing}: \"{answer[:150]}\""

    if case.get("expect_min_similarity") and sources:
        top_similarity = sources[0].get("similarity", 0)
        if top_similarity < case["expect_min_similarity"]:
            return False, f"top match similarity {top_similarity:.3f} below expected {case['expect_min_similarity']}"

    if case.get("expect_not_source"):
        cited_sources = [s["source_document"] for s in sources]
        if case["expect_not_source"] in cited_sources[:1]:
            return False, f"top match incorrectly came from '{case['expect_not_source']}'"

    return True, f"answer: \"{answer[:100]}...\""


def run():
    results = []
    for case in EVAL_CASES:
        try:
            passed, reason = check_case(case)
        except requests.exceptions.RequestException as e:
            passed, reason = False, f"request failed: {e}"

        results.append((case["name"], passed, reason))
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {case['name']}: {reason}")

    total = len(results)
    passed_count = sum(1 for _, p, _ in results if p)
    print(f"\n{passed_count}/{total} passed")

    return results


if __name__ == "__main__":
    run()
