/**
 * Normalize delegation scoring for team activity + inbox UI.
 */

function mapCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const agentId = String(c.agentId || '').trim();
  if (!agentId) return null;
  return {
    agentId,
    title: String(c.title || '').trim(),
    score: Number(c.score || 0),
    confidence: Number(c.confidence || 0),
    matchedSkills: Array.isArray(c.matchedSkills) ? c.matchedSkills.filter(Boolean) : [],
    matchedConcepts: Array.isArray(c.matchedConcepts) ? c.matchedConcepts.filter(Boolean) : [],
    reasoning: String(c.reasoning || (Array.isArray(c.reasons) ? c.reasons.join('; ') : '') || '').trim(),
  };
}

/**
 * @param {ReturnType<import('./agent-delegation-router.js').buildDelegationContext>} delegationContext
 * @returns {object | null}
 */
export function buildDelegationDecisionDetails(delegationContext) {
  if (!delegationContext?.recommendation) return null;
  const rec = delegationContext.recommendation;
  const selectedId = String(rec.targetAgentId || '').trim();
  const teamAgents = Array.isArray(delegationContext.teamCapability?.agents)
    ? delegationContext.teamCapability.agents
    : [];
  const fromTeam = teamAgents
    .map((a) => mapCandidate({
      agentId: a.agentId,
      title: a.title,
      score: a.score,
      confidence: a.confidence,
      matchedSkills: a.matchedSkills,
      matchedConcepts: a.matchedConcepts,
      reasoning: a.reasoning,
    }))
    .filter(Boolean);
  const fromCandidates = (Array.isArray(delegationContext.candidates) ? delegationContext.candidates : [])
    .map(mapCandidate)
    .filter(Boolean);
  const byId = new Map();
  fromTeam.forEach((c) => byId.set(c.agentId, c));
  fromCandidates.forEach((c) => {
    const prev = byId.get(c.agentId);
    byId.set(c.agentId, prev ? { ...prev, ...c, reasoning: c.reasoning || prev.reasoning } : c);
  });
  const candidates = [...byId.values()]
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, 6);
  const selectedRow = candidates.find((c) => c.agentId === selectedId) || null;
  return {
    reason: String(rec.reason || '').trim(),
    selected: selectedId,
    action: String(rec.action || '').trim(),
    selectedScore: Number(rec.score || selectedRow?.score || 0),
    selectedConfidence: Number(rec.confidence || selectedRow?.confidence || 0),
    selectedMatchedSkills: rec.matchedSkills || selectedRow?.matchedSkills || [],
    selectedMatchedConcepts: rec.matchedConcepts || selectedRow?.matchedConcepts || [],
    offerUpgrade: !!rec.offerUpgrade,
    suggestedDomain: String(rec.suggestedDomain || '').trim(),
    blocked: !!rec.blocked,
    routingMethod: String(rec.routingMethod || 'keyword').trim(),
    keywordAction: String(rec.keywordAction || '').trim(),
    llmAction: String(rec.llmAction || '').trim(),
    llmConfidence: Number.isFinite(Number(rec.llmConfidence)) ? Number(rec.llmConfidence) : null,
    llmReason: String(rec.llmReason || '').trim(),
    llmTargetAgentId: String(rec.llmTargetAgentId || '').trim(),
    routes: Array.isArray(rec.routes)
      ? rec.routes.map((r) => ({
          task: String(r.task || '').trim(),
          agent: String(r.agent || '').trim(),
          confidence: Number(r.confidence || 0),
          reason: String(r.reason || '').trim(),
          type: String(r.type || '').trim(),
          taskId: String(r.taskId || '').trim(),
        })).filter((r) => r.task && r.agent)
      : [],
    candidates,
    teamAgents: teamAgents.slice(0, 6).map((a) => ({
      agentId: a.agentId,
      confidencePct: a.confidencePct,
      score: a.score,
      reasoning: a.reasoning,
    })),
  };
}
