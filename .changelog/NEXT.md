# Unreleased Changes

## CoS agent failure reporting

- Failed agent runs are classified far more accurately. A terminal-UI agent's transcript is a repainted *screen*, not a log — it can run to hundreds of kilobytes while containing barely any line breaks — so the analyzer's "look at the recent output" window was quietly reading the entire session. Any keyword anywhere in it, including commands the agent itself typed, decided the verdict: one run reaped for going idle was reported as "Context length exceeded", which blocked its task and auto-filed an investigation for a problem that never happened.
- When the system already knows why a run ended — the idle watchdog fired, the runtime budget ran out, the provider CLI wasn't installed — that is now what gets reported. Only a genuine provider or system error in the transcript can override it.
- Failure snippets shown on an agent's record are now short, readable excerpts centered on the actual error instead of raw terminal escape codes. One failed run had been writing an 816KB blob of control characters into its own record.
