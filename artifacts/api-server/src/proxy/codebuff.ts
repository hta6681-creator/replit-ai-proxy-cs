const CODEBUFF_BASE = "https://www.codebuff.com";

export async function startCodebuffRun(auth: string): Promise<string> {
  const res = await fetch(`${CODEBUFF_BASE}/api/v1/agent-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ action: "START", agentId: "base2-free", ancestorRunIds: [] }),
  });
  if (!res.ok) throw new Error(`startRun: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { runId: string }).runId;
}

export async function finishCodebuffRun(runId: string, auth: string): Promise<void> {
  try {
    await fetch(`${CODEBUFF_BASE}/api/v1/agent-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        action: "FINISH", runId, status: "completed",
        totalSteps: 0, directCredits: 0, totalCredits: 0,
      }),
    });
  } catch {}
}

export async function codebuffChatCompletions(
  body: Record<string, unknown>,
  auth: string,
): Promise<Response & { __runId: string }> {
  const runId = await startCodebuffRun(auth);
  const cbBody = {
    ...body,
    codebuff_metadata: { run_id: runId, cost_mode: "free" },
  };
  const upstream = await fetch(`${CODEBUFF_BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(cbBody),
  });
  return Object.assign(upstream, { __runId: runId });
}

export { CODEBUFF_BASE };
