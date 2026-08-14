import React, { useState, useRef, useEffect } from "react";

const BACKEND_URL = "https://ragnotes-backend-zxrg.onrender.com";
const ACCENT = "#D85A30";
const ACCENT_BG = "#FAECE7";
const ACCENT_DARK = "#712B13";
const SESSION_KEY = "ragnotes_session_id";
const EXAMPLE_DOC_NAME = "example_octopus.txt";
const EXAMPLE_DOC_TEXT = `Octopuses are widely considered among the most intelligent invertebrates on Earth, despite having a nervous system radically different from vertebrates. Roughly two-thirds of an octopus's neurons are located not in its central brain but distributed throughout its eight arms, allowing each arm to process sensory information and make certain movements semi-independently, even after being separated from the body in laboratory studies. This decentralized nervous system lets an octopus's arms taste and touch simultaneously, since their skin is covered in chemoreceptors as well as touch-sensitive suckers.

In captivity, octopuses have demonstrated an ability to solve puzzles, open childproof jars to reach food, and navigate mazes, and some individuals have been observed using coconut shells or discarded shells as portable shelters, a behavior researchers consider a rare example of tool use in invertebrates. Octopuses also display short-term problem-solving and observational learning, in some experiments appearing to learn a task faster after watching another octopus complete it first. Despite this intelligence, most octopus species live only one to two years, and nearly all species die shortly after reproducing, meaning individual octopuses never have the chance to pass learned knowledge to offspring or other members of a longer-lived social group.`;
const EXAMPLE_QUESTION =
  "How is an octopus's nervous system different from a vertebrate's?";

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export default function App() {
  const sessionId = useRef(getSessionId());

  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 720);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");

  const fileInputRef = useRef(null);
  const dragCounter = useRef(0);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  function authHeaders(extra = {}) {
    return { "X-Session-Id": sessionId.current, ...extra };
  }

  useEffect(() => {
    async function loadDocuments() {
      try {
        const res = await fetch(`${BACKEND_URL}/documents`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setDocuments(data.documents || []);
        }
      } catch (e) {
        // Silent fail on load, not critical enough to show an error for.
      } finally {
        setDocumentsLoading(false);
      }
    }
    async function loadConversation() {
      try {
        const res = await fetch(`${BACKEND_URL}/conversation`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          const loaded = (data.messages || []).map((m) => ({
            role: m.role,
            text: m.content,
            sources: m.sources || [],
          }));
          setMessages(loaded);
        }
      } catch (e) {
        // Silent fail, an empty conversation is a fine fallback.
      }
    }
    loadDocuments();
    loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth < 720);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    function onDragEnter(e) {
      e.preventDefault();
      dragCounter.current += 1;
      if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
    }
    function onDragOver(e) {
      e.preventDefault();
    }
    function onDragLeave(e) {
      e.preventDefault();
      dragCounter.current -= 1;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setDragging(false);
      }
    }
    function onDrop(e) {
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFileUpload(file);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFileUpload(file) {
    if (!file.name.endsWith(".txt")) {
      setUploadError("Only .txt files are supported right now.");
      return;
    }
    setUploading(true);
    setUploadError("");
    setUploadSuccess("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${BACKEND_URL}/upload-file`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      setDocuments((prev) => {
        const withoutDup = prev.filter((d) => d !== data.source_document);
        return [...withoutDup, data.source_document];
      });
      setUploadSuccess(
        data.replaced
          ? `Replaced ${data.source_document}`
          : `Uploaded ${data.source_document}`,
      );
      setTimeout(() => setUploadSuccess(""), 3000);
    } catch (e) {
      setUploadError(
        e.message || "Couldn't upload file. Is the backend running?",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handlePasteUpload() {
    if (!pasteName.trim()) {
      setUploadError("Give this document a name first.");
      return;
    }
    if (pasteText.trim().length < 100) {
      setUploadError("Add more content, at least 100 characters.");
      return;
    }
    setUploading(true);
    setUploadError("");
    setUploadSuccess("");
    try {
      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          source_document: pasteName.trim(),
          text: pasteText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");
      setDocuments((prev) => {
        const withoutDup = prev.filter((d) => d !== data.source_document);
        return [...withoutDup, data.source_document];
      });
      setUploadSuccess(
        data.replaced
          ? `Replaced ${data.source_document}`
          : `Uploaded ${data.source_document}`,
      );
      setTimeout(() => setUploadSuccess(""), 3000);
      setPasteText("");
      setPasteName("");
      setShowPaste(false);
    } catch (e) {
      setUploadError(
        e.message || "Couldn't upload text. Is the backend running?",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleRemoveDocument(docName) {
    setDocuments((prev) => prev.filter((d) => d !== docName));
    try {
      const res = await fetch(
        `${BACKEND_URL}/documents/${encodeURIComponent(docName)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to delete document");
      }
    } catch (e) {
      setDocuments((prev) =>
        prev.includes(docName) ? prev : [...prev, docName],
      );
      setUploadError(
        e.message || "Couldn't remove document. Is the backend running?",
      );
    }
  }

  async function handleTryExample() {
    setUploadError("");
    setAskError("");
    setUploading(true);

    try {
      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          source_document: EXAMPLE_DOC_NAME,
          text: EXAMPLE_DOC_TEXT,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to upload example");
      setDocuments((prev) => {
        const withoutDup = prev.filter((d) => d !== data.source_document);
        return [...withoutDup, data.source_document];
      });
      setUploadSuccess(
        data.replaced
          ? `Replaced ${data.source_document}`
          : `Uploaded ${data.source_document}`,
      );
      setTimeout(() => setUploadSuccess(""), 3000);
    } catch (e) {
      setUploadError(
        e.message || "Couldn't upload example. Is the backend running?",
      );
      setUploading(false);
      return;
    }
    setUploading(false);

    const q = EXAMPLE_QUESTION;
    setMessages((prev) => [...prev, { role: "question", text: q }]);
    setAsking(true);
    try {
      const res = await fetch(`${BACKEND_URL}/ask`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Something went wrong");
      setMessages((prev) => [
        ...prev,
        { role: "answer", text: data.answer, sources: data.sources || [] },
      ]);
    } catch (e) {
      setAskError(e.message || "Couldn't reach the backend. Is it running?");
    } finally {
      setAsking(false);
    }
  }

  async function handleAsk() {
    if (!question.trim()) return;
    const q = question.trim();
    setMessages((prev) => [...prev, { role: "question", text: q }]);
    setQuestion("");
    setAsking(true);
    setAskError("");
    try {
      const res = await fetch(`${BACKEND_URL}/ask`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Something went wrong");
      setMessages((prev) => [
        ...prev,
        { role: "answer", text: data.answer, sources: data.sources || [] },
      ]);
    } catch (e) {
      setAskError(e.message || "Couldn't reach the backend. Is it running?");
    } finally {
      setAsking(false);
    }
  }

  async function handleClearConversation() {
    const previous = messages;
    setMessages([]);
    try {
      const res = await fetch(`${BACKEND_URL}/conversation`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to clear conversation");
    } catch (e) {
      setMessages(previous);
      setAskError("Couldn't clear conversation. Is the backend running?");
    }
  }

  const notesPanelContent = (
    <>
      {documents.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <p
            style={{
              fontSize: 11,
              color: "#9a9a9a",
              margin: "0 0 6px",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
            }}>
            Uploaded
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {documents.map((doc) => (
              <div
                key={doc}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "white",
                  border: "0.5px solid #e5e5e5",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}>
                <i
                  className="fa-solid fa-file-lines"
                  style={{ fontSize: 14, color: ACCENT_DARK, flexShrink: 0 }}
                  aria-hidden="true"></i>
                <span
                  style={{
                    fontSize: 13,
                    flex: 1,
                    color: "#1a1a1a",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                  {doc}
                </span>
                <button
                  onClick={() => handleRemoveDocument(doc)}
                  className="remove-btn"
                  aria-label={`Remove ${doc}`}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#6b6b6b",
                    padding: 2,
                    display: "flex",
                  }}>
                  <i
                    className="fa-solid fa-xmark"
                    style={{ fontSize: 13 }}
                    aria-hidden="true"></i>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        onClick={() => fileInputRef.current?.click()}
        style={{
          border:
            documents.length === 0 && !documentsLoading
              ? `1px dashed ${ACCENT}`
              : "1px dashed #c4c4c4",
          background:
            documents.length === 0 && !documentsLoading
              ? "white"
              : "transparent",
          borderRadius: 8,
          padding: "18px 12px",
          textAlign: "center",
          cursor: "pointer",
          fontSize: 14,
          color:
            documents.length === 0 && !documentsLoading
              ? ACCENT_DARK
              : "#5a5a5a",
          marginBottom: 10,
        }}>
        {uploading ? "Uploading..." : "Drop a .txt file or click to browse"}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files[0];
            if (file) handleFileUpload(file);
            e.target.value = "";
          }}
        />
      </div>

      <button
        onClick={() => setShowPaste((s) => !s)}
        className="paste-btn"
        style={{
          width: "100%",
          fontSize: 14,
          fontWeight: 500,
          borderRadius: 8,
          cursor: "pointer",
          padding: "9px 12px",
          textAlign: "center",
          transition: "all 0.15s ease",
        }}>
        {showPaste ? "Cancel" : "Paste text instead"}
      </button>

      {showPaste && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}>
          <input
            placeholder="Document name"
            value={pasteName}
            onChange={(e) => setPasteName(e.target.value)}
            style={{
              fontSize: 16,
              padding: "6px 8px",
              borderRadius: 6,
              border: "0.5px solid #d4d4d4",
            }}
          />
          <textarea
            placeholder="Paste your notes here..."
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={5}
            style={{
              fontSize: 16,
              padding: "6px 8px",
              borderRadius: 6,
              border: "0.5px solid #d4d4d4",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={handlePasteUpload}
            disabled={uploading}
            style={{
              fontSize: 14,
              padding: "6px 10px",
              borderRadius: 6,
              border: "none",
              background: ACCENT,
              color: "white",
              cursor: "pointer",
              fontWeight: 500,
            }}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      )}

      {uploadError && (
        <p style={{ fontSize: 13, color: "#a32d2d", marginTop: 8 }}>
          {uploadError}
        </p>
      )}
      {uploadSuccess && (
        <p
          style={{
            fontSize: 13,
            color: "#0f6e56",
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}>
          <i
            className="fa-solid fa-circle-check"
            style={{ fontSize: 12 }}
            aria-hidden="true"></i>
          {uploadSuccess}
        </p>
      )}

      {!documentsLoading && documents.length === 0 && (
        <p style={{ fontSize: 13, color: "#9a9a9a", marginTop: 12 }}>
          No documents uploaded yet.
        </p>
      )}
    </>
  );

  const exampleButton = (
    <button
      onClick={handleTryExample}
      className="paste-btn"
      style={{
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 8,
        cursor: "pointer",
        padding: "8px 14px",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        transition: "all 0.15s ease",
        flex: isMobile ? 1 : undefined,
        justifyContent: isMobile ? "center" : undefined,
      }}>
      <i
        className="fa-solid fa-sparkles"
        style={{ fontSize: 12 }}
        aria-hidden="true"></i>
      Try an example
    </button>
  );

  const chatPanel = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#fafafa",
        borderRadius: 12,
        border: "0.5px solid #e5e5e5",
        height: isMobile ? 480 : 560,
        boxSizing: "border-box",
      }}>
      {messages.length > 0 && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              padding: "12px 12px 10px",
            }}>
            <button
              onClick={handleClearConversation}
              className="clear-conversation-btn"
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "#4a4a4a",
                background: "white",
                border: "1px solid #d4d4d4",
                borderRadius: 8,
                padding: "6px 12px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}>
              <i
                className="fa-solid fa-trash-can"
                style={{ fontSize: 12 }}
                aria-hidden="true"></i>
              Clear conversation
            </button>
          </div>
          <div style={{ borderBottom: "0.5px solid #e0e0e0" }} />
        </div>
      )}
      <div
        style={{
          flex: 1,
          padding: 16,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}>
        {messages.length === 0 && (
          <p
            style={{
              fontSize: 15,
              color: "#4a4a4a",
              margin: "auto",
              textAlign: "center",
            }}>
            Upload a document, then ask something about it.
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "question" ? (
            <div
              key={i}
              style={{
                alignSelf: "flex-end",
                background: "#1a1a1a",
                color: "white",
                borderRadius: "14px 14px 2px 14px",
                padding: "8px 12px",
                fontSize: 15,
                maxWidth: "75%",
              }}>
              {m.text}
            </div>
          ) : (
            <div
              key={i}
              style={{
                alignSelf: "flex-start",
                background: "white",
                border: "0.5px solid #e5e5e5",
                borderRadius: "14px 14px 14px 2px",
                padding: "10px 12px",
                fontSize: 15,
                maxWidth: "85%",
                lineHeight: 1.5,
                color: "#1a1a1a",
              }}>
              {m.text}
              {m.sources && m.sources.length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                  }}>
                  {m.sources.map((s, si) => (
                    <span
                      key={si}
                      title={s.content?.slice(0, 120)}
                      style={{
                        fontSize: 12,
                        background: ACCENT_BG,
                        color: ACCENT_DARK,
                        borderRadius: 20,
                        padding: "2px 8px",
                        cursor: "default",
                      }}>
                      {s.source_document} · {(s.similarity * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {asking && (
          <div
            style={{ alignSelf: "flex-start", fontSize: 14, color: "#6b6b6b" }}>
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {askError && (
        <p style={{ fontSize: 15, color: "#a32d2d", padding: "0 16px" }}>
          {askError}
        </p>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 12,
          borderTop: "0.5px solid #e5e5e5",
        }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
          placeholder="Ask a question about your notes..."
          style={{
            flex: 1,
            fontSize: 16,
            padding: "9px 12px",
            borderRadius: 20,
            border: "0.5px solid #d4d4d4",
            outline: "none",
          }}
        />
        <button
          onClick={handleAsk}
          disabled={asking || !question.trim()}
          className="send-btn"
          style={{
            width: 38,
            height: 38,
            borderRadius: "50%",
            border: "none",
            background: ACCENT,
            color: "white",
            cursor: asking || !question.trim() ? "default" : "pointer",
            opacity: asking || !question.trim() ? 0.4 : 1,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transition: "transform 0.1s ease, background 0.15s ease",
          }}>
          <i className="fa-solid fa-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  );

  const sharedStyles = (
    <style>{`
      .send-btn:not(:disabled):hover {
        background: ${ACCENT_DARK} !important;
        transform: scale(1.06);
      }
      .send-btn:not(:disabled):active {
        transform: scale(0.94);
      }
      .paste-btn {
        color: #1a1a1a !important;
        background: white !important;
        border: 1px solid #d4d4d4 !important;
      }
      .paste-btn:hover {
        background: white !important;
        border-color: ${ACCENT} !important;
        color: ${ACCENT_DARK} !important;
      }
      .remove-btn {
        opacity: 0.5;
        transition: opacity 0.15s ease, color 0.15s ease;
      }
      .remove-btn:hover {
        opacity: 1;
        color: #a32d2d !important;
      }
      .clear-conversation-btn {
        transition: all 0.15s ease;
      }
      .clear-conversation-btn:hover {
        background: #f5f5f5 !important;
        border-color: #b0b0b0 !important;
      }
      .manage-notes-btn {
        transition: all 0.15s ease;
      }
      .manage-notes-btn.neutral:hover {
        background: #f0f0f0 !important;
      }
      .manage-notes-btn.accented:hover {
        background: #f5d9cc !important;
      }
    `}</style>
  );

  const dragOverlay = dragging && (
    <div
      style={{
        position: "fixed",
        inset: 16,
        background: "rgba(245, 245, 243, 0.94)",
        border: "1.5px dashed #b0b0ac",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        zIndex: 1000,
        pointerEvents: "none",
      }}>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "0.5px solid #e5e5e5",
        }}>
        <i
          className="fa-solid fa-file-arrow-up"
          style={{ fontSize: 22, color: "#1a1a1a" }}
          aria-hidden="true"></i>
      </div>
      <p style={{ fontSize: 16, fontWeight: 600, color: "#1a1a1a", margin: 0 }}>
        Drop your file anywhere
      </p>
      <p style={{ fontSize: 13, color: "#6b6b6b", margin: 0 }}>
        .txt files only
      </p>
    </div>
  );

  // ---------------------------------------------------------------------
  // MOBILE LAYOUT
  // ---------------------------------------------------------------------
  if (isMobile) {
    return (
      <div
        style={{
          maxWidth: 480,
          margin: "0 auto",
          padding: "1.25rem 1rem",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          position: "relative",
        }}>
        {sharedStyles}
        {dragOverlay}

        {drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              zIndex: 900,
            }}
          />
        )}

        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            bottom: 0,
            width: "80%",
            maxWidth: 320,
            background: "#fafafa",
            boxShadow: "4px 0 20px rgba(0,0,0,0.15)",
            padding: 18,
            zIndex: 950,
            overflowY: "auto",
            boxSizing: "border-box",
            transform: drawerOpen ? "translateX(0)" : "translateX(-105%)",
            transition: "transform 0.25s ease",
          }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}>
            <p
              style={{
                fontSize: 16,
                fontWeight: 600,
                margin: 0,
                color: "#1a1a1a",
              }}>
              Your notes
            </p>
            <button
              onClick={() => setDrawerOpen(false)}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}>
              <i
                className="fa-solid fa-xmark"
                style={{ fontSize: 16, color: "#1a1a1a" }}
                aria-hidden="true"></i>
            </button>
          </div>
          {notesPanelContent}
        </div>

        <p
          style={{
            fontSize: 19,
            fontWeight: 600,
            margin: "0 0 10px",
            color: "#1a1a1a",
          }}>
          RAG Notes
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            onClick={() => setDrawerOpen(true)}
            className={`manage-notes-btn ${documents.length === 0 && !documentsLoading ? "accented" : "neutral"}`}
            disabled={documentsLoading}
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: "7px 10px",
              borderRadius: 8,
              cursor: documentsLoading ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              flex: 1,
              border:
                documents.length === 0 && !documentsLoading
                  ? `1px solid ${ACCENT}`
                  : "1px solid #d4d4d4",
              background:
                documents.length === 0 && !documentsLoading
                  ? ACCENT_BG
                  : "#fafafa",
              color:
                documents.length === 0 && !documentsLoading
                  ? ACCENT_DARK
                  : "#1a1a1a",
              opacity: documentsLoading ? 0.6 : 1,
            }}>
            {documentsLoading ? (
              <i
                className="fa-solid fa-spinner fa-spin"
                style={{ fontSize: 12 }}
                aria-hidden="true"></i>
            ) : (
              <i
                className={
                  documents.length === 0
                    ? "fa-solid fa-file-circle-plus"
                    : "fa-solid fa-file-lines"
                }
                style={{ fontSize: 13 }}
                aria-hidden="true"></i>
            )}
            {documentsLoading
              ? "Loading"
              : documents.length === 0
                ? "Add notes"
                : `Manage (${documents.length})`}
            {documents.length > 0 && !documentsLoading && (
              <i
                className="fa-solid fa-chevron-right"
                style={{ fontSize: 10, color: "#9a9a9a" }}
                aria-hidden="true"></i>
            )}
          </button>
          {exampleButton}
        </div>

        {chatPanel}
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // DESKTOP LAYOUT
  // ---------------------------------------------------------------------
  return (
    <div
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: "2rem 1.5rem",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        position: "relative",
      }}>
      {sharedStyles}
      {dragOverlay}

      <header style={{ marginBottom: "1rem" }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            margin: 0,
            color: "#1a1a1a",
          }}>
          RAG Notes
        </h1>
        <p style={{ fontSize: 16, color: "#6b6b6b", margin: "6px 0 0" }}>
          Ask questions about your own notes, grounded in what you upload.
        </p>
      </header>

      <div style={{ marginBottom: "1.5rem" }}>{exampleButton}</div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: 16,
          alignItems: "stretch",
        }}>
        <div
          style={{
            background:
              documents.length === 0 && !documentsLoading
                ? ACCENT_BG
                : "#fafafa",
            borderRadius: 12,
            padding: 18,
            border:
              documents.length === 0 && !documentsLoading
                ? `1px solid ${ACCENT}`
                : "0.5px solid #e5e5e5",
            height: "100%",
            overflowY: "auto",
            boxSizing: "border-box",
            display: documentsLoading ? "flex" : "block",
            alignItems: documentsLoading ? "center" : undefined,
            justifyContent: documentsLoading ? "center" : undefined,
          }}>
          {documentsLoading ? (
            <div style={{ textAlign: "center" }}>
              <i
                className="fa-solid fa-spinner fa-spin"
                style={{ fontSize: 20, color: "#9a9a9a" }}
                aria-hidden="true"></i>
              <p style={{ fontSize: 13, color: "#9a9a9a", margin: "10px 0 0" }}>
                Loading notes...
              </p>
            </div>
          ) : (
            <>
              <p
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  margin: "0 0 14px",
                  color: documents.length === 0 ? ACCENT_DARK : "#1a1a1a",
                }}>
                Notes
              </p>
              {notesPanelContent}
            </>
          )}
        </div>

        {chatPanel}
      </div>
    </div>
  );
}
