import { useState, useEffect, useCallback } from "react";

interface ModelData {
  id: string;
  owned_by: string;
}

interface ProviderStatsData {
  totalCalls: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number;
  avgTtftMs: number;
}

interface StatsData {
  uptime: string;
  rateLimit: { active: number; queued: number };
  providers: {
    openai: ProviderStatsData;
    anthropic: ProviderStatsData;
    openrouter: ProviderStatsData;
  };
}

const THINKING_TAGS = ["thinking", "thinking-max"] as const;

function getModelTags(id: string, ownedBy: string): string[] {
  const tags: string[] = [];
  for (const t of THINKING_TAGS) {
    if (id.endsWith(`-${t}`)) tags.push(t);
  }
  return tags;
}

const endpoints = [
  { method: "GET", path: "/v1/models", desc: "List available models" },
  { method: "POST", path: "/v1/chat/completions", desc: "OpenAI-compatible chat (GPT + Claude)" },
  { method: "POST", path: "/v1/messages", desc: "Anthropic native format (Claude only, for Claude Code)" },
  { method: "GET", path: "/v1/stats", desc: "Usage statistics" },
];

const tagColors: Record<string, string> = {
  OpenAI: "hsl(210, 100%, 60%)",
  Anthropic: "hsl(30, 100%, 60%)",
  thinking: "hsl(270, 80%, 65%)",
  "thinking-max": "hsl(0, 80%, 60%)",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [text]);
  return (
    <button onClick={handleCopy} style={styles.copyBtn}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export default function App() {
  const [apiKey, setApiKey] = useState(
    () => sessionStorage.getItem("proxy_api_key") ?? "",
  );
  const [health, setHealth] = useState<boolean | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsError, setStatsError] = useState("");
  const [models, setModels] = useState<ModelData[]>([]);
  const baseUrl = window.location.origin;

  useEffect(() => {
    fetch("/api/healthz")
      .then((r) => setHealth(r.ok))
      .catch(() => setHealth(false));
  }, []);

  useEffect(() => {
    if (!apiKey) {
      setModels([]);
      return;
    }
    fetch("/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d) => setModels(d.data || []))
      .catch(() => setModels([]));
  }, [apiKey]);

  const handleKeyChange = useCallback((v: string) => {
    setApiKey(v);
    if (v) sessionStorage.setItem("proxy_api_key", v);
    else sessionStorage.removeItem("proxy_api_key");
  }, []);

  const fetchStats = useCallback(() => {
    if (!apiKey) {
      setStatsError("Enter API key above");
      return;
    }
    fetch("/v1/stats", { headers: { Authorization: `Bearer ${apiKey}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d) => { setStats(d); setStatsError(""); })
      .catch((e) => { setStatsError(e.message); setStats(null); });
  }, [apiKey]);

  useEffect(() => {
    if (!apiKey) return;
    fetchStats();
    const id = setInterval(fetchStats, 30000);
    return () => clearInterval(id);
  }, [apiKey, fetchStats]);

  const openaiModels = models.filter((m) => m.owned_by === "openai");
  const anthropicModels = models.filter((m) => m.owned_by === "anthropic");

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>AI Proxy Portal</h1>
        <div style={styles.healthRow}>
          <span
            style={{
              ...styles.healthDot,
              backgroundColor: health === null ? "gray" : health ? "#22c55e" : "#ef4444",
            }}
          />
          <span>{health === null ? "Checking..." : health ? "Healthy" : "Unreachable"}</span>
        </div>
      </header>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>API Key</h2>
        <div style={styles.row}>
          <input
            type="password"
            placeholder="Enter PROXY_API_KEY for stats & testing"
            value={apiKey}
            onChange={(e) => handleKeyChange(e.target.value)}
            style={styles.input}
          />
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Base URL</h2>
        <div style={styles.codeRow}>
          <code style={styles.code}>{baseUrl}</code>
          <CopyButton text={baseUrl} />
        </div>
        <p style={styles.muted}>
          Authentication: <code style={styles.inlineCode}>Authorization: Bearer &lt;key&gt;</code> or{" "}
          <code style={styles.inlineCode}>x-api-key: &lt;key&gt;</code>
        </p>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Endpoints</h2>
        <div style={styles.table}>
          {endpoints.map((ep) => (
            <div key={ep.path} style={styles.tableRow}>
              <span style={{ ...styles.method, color: ep.method === "GET" ? "#22c55e" : "#60a5fa" }}>
                {ep.method}
              </span>
              <code style={styles.inlineCode}>{ep.path}</code>
              <CopyButton text={baseUrl + ep.path} />
              <span style={styles.muted}>{ep.desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>
          Models{models.length > 0 ? ` (${models.length})` : ""}
        </h2>
        {models.length === 0 && (
          <p style={styles.muted}>Enter API key above to load models</p>
        )}

        {openaiModels.length > 0 && (
          <>
            <h3 style={styles.groupTitle}>OpenAI</h3>
            <div style={styles.modelList}>
              {openaiModels.map((m) => (
                <div key={m.id} style={styles.modelItem}>
                  <code style={styles.inlineCode}>{m.id}</code>
                  <span style={{ ...styles.tag, backgroundColor: tagColors.OpenAI }}>OpenAI</span>
                </div>
              ))}
            </div>
          </>
        )}

        {anthropicModels.length > 0 && (
          <>
            <h3 style={styles.groupTitle}>Anthropic</h3>
            <div style={styles.modelList}>
              {anthropicModels.map((m) => (
                <div key={m.id} style={styles.modelItem}>
                  <code style={styles.inlineCode}>{m.id}</code>
                  <span style={{ ...styles.tag, backgroundColor: tagColors.Anthropic }}>Anthropic</span>
                  {getModelTags(m.id, m.owned_by).map((t) => (
                    <span key={t} style={{ ...styles.tag, backgroundColor: tagColors[t] || "#888" }}>
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>CherryStudio Configuration</h2>
        <ol style={styles.steps}>
          <li>Add a new <strong>OpenAI</strong> provider</li>
          <li>
            Set Base URL to: <code style={styles.inlineCode}>{baseUrl}/v1</code>
            <CopyButton text={baseUrl + "/v1"} />
          </li>
          <li>Set API Key to your <code style={styles.inlineCode}>PROXY_API_KEY</code></li>
          <li>Click "Fetch Models" to load the model list</li>
        </ol>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Claude Code Configuration</h2>
        <div style={styles.codeBlock}>
          <code>
            {`export ANTHROPIC_BASE_URL="${baseUrl}/v1"\nexport ANTHROPIC_API_KEY="your-proxy-api-key"`}
          </code>
        </div>
        <CopyButton
          text={`export ANTHROPIC_BASE_URL="${baseUrl}/v1"\nexport ANTHROPIC_API_KEY="your-proxy-api-key"`}
        />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Usage Statistics</h2>
        <button onClick={fetchStats} style={styles.btn}>
          Refresh Stats
        </button>
        <span style={{ ...styles.muted, marginLeft: 12 }}>Auto-refreshes every 30s</span>
        {statsError && <p style={{ color: "#ef4444", marginTop: 8 }}>{statsError}</p>}
        {stats && (
          <div style={{ marginTop: 16 }}>
            <p>
              Uptime: <strong>{stats.uptime}</strong> | Queue: active={stats.rateLimit.active}, queued=
              {stats.rateLimit.queued}
            </p>
            <table style={styles.statsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>Provider</th>
                  <th style={styles.th}>Calls</th>
                  <th style={styles.th}>Errors</th>
                  <th style={styles.th}>Prompt Tokens</th>
                  <th style={styles.th}>Completion Tokens</th>
                  <th style={styles.th}>Avg Duration</th>
                  <th style={styles.th}>Avg TTFT</th>
                </tr>
              </thead>
              <tbody>
                {(["openai", "anthropic", "openrouter"] as const).map((p) => {
                  const s = stats.providers[p];
                  return (
                    <tr key={p}>
                      <td style={styles.td}>{p}</td>
                      <td style={styles.td}>{s.totalCalls}</td>
                      <td style={styles.td}>{s.errorCount}</td>
                      <td style={styles.td}>{s.promptTokens.toLocaleString()}</td>
                      <td style={styles.td}>{s.completionTokens.toLocaleString()}</td>
                      <td style={styles.td}>{s.avgDurationMs}ms</td>
                      <td style={styles.td}>{s.avgTtftMs}ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Notes</h2>
        <ul style={styles.notes}>
          <li>GPT-5 models don't support temperature/top_p parameters (they are silently dropped)</li>
          <li>Image URLs in messages are automatically converted to base64 for Anthropic</li>
          <li>cache_control.scope is stripped before forwarding to upstream (Replit limitation)</li>
          <li>429 rate limit errors trigger automatic exponential backoff retry (up to 7 retries)</li>
          <li>Concurrent request limit: 3 (additional requests are queued)</li>
        </ul>
      </section>

      <footer style={styles.footer}>
        <p style={styles.muted}>OpenAI Compatible Reverse Proxy on Replit</p>
      </footer>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 900,
    margin: "0 auto",
    padding: "32px 24px",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 32,
    paddingBottom: 16,
    borderBottom: "1px solid hsl(215, 20%, 20%)",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "hsl(210, 40%, 96%)",
  },
  healthRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
  },
  healthDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  section: {
    marginBottom: 32,
    padding: 20,
    backgroundColor: "hsl(222, 40%, 14%)",
    borderRadius: 8,
    border: "1px solid hsl(215, 20%, 20%)",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 12,
    color: "hsl(210, 40%, 90%)",
  },
  groupTitle: {
    fontSize: 15,
    fontWeight: 600,
    marginTop: 16,
    marginBottom: 8,
    color: "hsl(210, 30%, 75%)",
  },
  row: { display: "flex", gap: 8, alignItems: "center" },
  codeRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const },
  code: {
    fontFamily: "monospace",
    fontSize: 15,
    padding: "6px 12px",
    backgroundColor: "hsl(222, 40%, 18%)",
    borderRadius: 4,
    color: "#60a5fa",
  },
  inlineCode: {
    fontFamily: "monospace",
    fontSize: 13,
    padding: "2px 6px",
    backgroundColor: "hsl(222, 40%, 18%)",
    borderRadius: 3,
    color: "#93c5fd",
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: 13,
    padding: 12,
    backgroundColor: "hsl(222, 40%, 10%)",
    borderRadius: 6,
    overflowX: "auto" as const,
    whiteSpace: "pre" as const,
    marginBottom: 8,
    color: "#93c5fd",
  },
  muted: {
    fontSize: 13,
    color: "hsl(215, 15%, 55%)",
    marginTop: 8,
  },
  input: {
    flex: 1,
    padding: "8px 12px",
    borderRadius: 4,
    border: "1px solid hsl(215, 20%, 25%)",
    backgroundColor: "hsl(222, 40%, 10%)",
    color: "hsl(210, 40%, 90%)",
    fontSize: 14,
    fontFamily: "monospace",
    outline: "none",
  },
  copyBtn: {
    padding: "4px 10px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid hsl(215, 20%, 30%)",
    backgroundColor: "hsl(222, 40%, 18%)",
    color: "hsl(210, 40%, 80%)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  btn: {
    padding: "8px 16px",
    fontSize: 14,
    borderRadius: 6,
    border: "none",
    backgroundColor: "hsl(210, 100%, 50%)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },
  table: { display: "flex", flexDirection: "column" as const, gap: 8, marginTop: 8 },
  tableRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "6px 0",
    flexWrap: "wrap" as const,
  },
  method: { fontWeight: 700, fontFamily: "monospace", fontSize: 13, minWidth: 40 },
  modelList: { display: "flex", flexDirection: "column" as const, gap: 6 },
  modelItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
  },
  tag: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 10,
    color: "#fff",
    fontWeight: 600,
  },
  steps: { paddingLeft: 20, display: "flex", flexDirection: "column" as const, gap: 8 },
  notes: { paddingLeft: 20, display: "flex", flexDirection: "column" as const, gap: 6, fontSize: 14 },
  statsTable: {
    width: "100%",
    borderCollapse: "collapse" as const,
    marginTop: 12,
    fontSize: 13,
  },
  th: {
    textAlign: "left" as const,
    padding: "8px 12px",
    borderBottom: "1px solid hsl(215, 20%, 25%)",
    color: "hsl(210, 30%, 70%)",
    fontWeight: 600,
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid hsl(215, 20%, 18%)",
  },
  footer: {
    marginTop: 48,
    paddingTop: 16,
    borderTop: "1px solid hsl(215, 20%, 20%)",
    textAlign: "center" as const,
  },
} satisfies Record<string, React.CSSProperties>;
