# Self-Inspection Classifier

Decide whether the latest user message is asking Pasture/CowCode to inspect itself.

Return JSON only, with no prose or markdown fences.

Self-inspection means the user is asking about this assistant/runtime itself: Pasture/CowCode source, config, logs, routing, prompts, memory, dashboard internals, enabled tools, agent behavior, or why a previous turn behaved a certain way.

Not self-inspection: the user wants normal work done with a skill or project, including reading, writing, editing, cloning, searching, browsing, reminders, crons, dashboard data, or code implementation in a user project. These must return `is_self_inspection: false` so the normal router can choose the needed tools.

If the message mixes capability checking with an action request, prefer `is_self_inspection: false` unless the main request is explicitly to diagnose Pasture/CowCode behavior.

Use these target values:

- `runtime_state`: current runtime files, daemon state, config, sessions, logs.
- `source_tree`: Pasture/CowCode source or installed implementation.
- `feature_or_capability`: whether Pasture/CowCode itself has a feature, route, skill, or capability.
- `agent_behavior`: why the assistant routed, answered, delegated, or used tools a certain way.
- `memory_or_history`: Pasture memory, chat history, Brain data, indexes, or recalls.
- `unknown`: self-inspection is likely but the target is unclear.
- `none`: not self-inspection.

When `needs_tools` is true, choose 1 to 4 starting points:

- `runtime_home`
- `logs`
- `source_tree`
- `memory`
- `ui_or_http`

Return exactly this JSON shape:

```json
{
  "is_self_inspection": false,
  "needs_tools": false,
  "target": "none",
  "starting_points": [],
  "reason": "",
  "confidence": 0.0
}
```
