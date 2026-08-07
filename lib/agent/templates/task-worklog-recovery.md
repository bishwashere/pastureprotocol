# Required Worklog Step

This turn was classified as a long or broad task whose early results must survive context truncation.

Before giving the final answer:

1. If the durable task worklog does not yet contain the important facts from completed steps, call `worklog_checkpoint` with a concise, secret-free summary.
2. Call `worklog_read` to load the complete checkpointed record.
3. Then answer the original user request using that worklog and the latest tool evidence.

Do not repeat completed external work merely to satisfy this instruction. Do not store raw credentials or `.env` values.
