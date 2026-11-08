# Overnight run: dsh-superagent on Windows

Written 2026-11-08 around 02:40 local, after the unattended stretch that started when you went to sleep.

## Where it stands

The service is up and healthy, and the whole loop has been exercised end to end - including the parts that used to be broken on Windows.

| | |
| --- | --- |
| Service | `http://127.0.0.1:3082`, pid 49156, started by the scheduled task |
| Components | runtime, relay, notice, launch, delivery, assessment, reply, evals, models, github - all `ready`, `problems: []` |
| Identity | `lhz-agent` (isolated gh config dir), repository `xielhz/superagent-sandbox` |
| Settings | eval `auto` (rev 4), executor maxWorkers 3 (rev 0), source github rev 4 with issues/comments/pulls observed |
| Flow | received 12, triggers 12, judged 9, accepted 4, evaluating 0, dropped 0 |
| Tickets | 2 open, both at `person/review`; 2 ended (`completed`, `merged`) |
| Pull requests | #3 `docs/notes.md` and #4 `docs/guide.md` open and waiting for your review; #6 merged |

## What was proven tonight

1. **A rule-judged request really executes.** Issue #5 (spelling in `docs/faq.md`, no `@mention`) was assessed by the `copy` rule, accepted with a written reason, forked into a worktree, committed as `lhz-agent`, pushed as `agent/fix-faq-typos-ad2930bdb99a`, opened as PR #6, and reported back on the issue.
2. **The human gate closes the loop.** Enabling `observePulls` and merging PR #6 flipped the ticket to `ended: {"outcome":"merged"}` within one poll, and it left the open list. (No GitHub comment accompanies a merge, by design - `pullEndNotices` skips GitHub channels because the timeline already shows it.)
3. **Auto mode also refuses.** Issue #7 asked for a doc restructure and a new changelog; the assessment returned `ignore` / `ignoredFromCard` with a written justification and opened no ticket. `accepted` stayed at 4 while `judged` went to 9.
4. **Crash recovery works, twice.** Killing the host without the stop marker leaves a stale `superagent.lock`; the scheduled task starts it again anyway, and the script removes the lock first. Measured: kill -> 90 s -> `runtime=ready`, same tickets, same identity.
5. **Idle is not "waiting for you".** Two tickets sat at stage `idle` for an hour with open PRs because their workers reported `waiting` (not `ready`). A comment on each PR thread woke them; both now read `person/review`. Operational rule: only `person/review` means someone must act.

## Health trail without a monitor

The control script's exit line now carries a health snapshot whenever the management API answered, so `audit.log` doubles as a health trail at the scheduled task's cadence (every ten minutes):

```text
2026-11-08T02:56:45.1508051 pid=50200 user=Dell action=start ... respectStop=True exit=0 health=runtime:ready,relay:ready,notice:ready,launch:ready,delivery:ready,assessment:ready,reply:ready,evals:ready,models:ready,github:ready
```

`scripts/superagent-patrol.ps1` is the finer-grained check (it also notices a ticket waiting at `person/review` and a stale lock); the audit line is what proves the schedule itself kept running.

Everything below is committed locally as `36ad6a7` on top of the upstream `8c32a9d` (nothing pushed): source patches, the PowerShell scripts, `WINDOWS.md`, and this report.

## Two bugs fixed in the source

* **Notification lookback** (`src/sources/github.ts`): the poll cursor advanced to the start of each round while GitHub indexes notifications with a delay, so comments written just before a round were lost forever. Now a 180 s lookback window is re-read on every round; trigger IDs are content hashes, so re-reading is idempotent.
* **`bash` on Windows** (`src/app/sessions.ts:263`): `tools.restrict("bash")` threw `unknown global tool "bash"` on Windows, which deactivated the whole plugin and made every `/orchestrator/*` route 404. Now the shell name follows the platform (`pwsh`).

The earlier Windows patches (absolute paths with drive letters, `env`-less worker probes, `.cmd` shims, credential helper, exec-directory validation) are documented in `WINDOWS.md`.

## What you may want to do next

* **Review and merge PR #3 and PR #4.** They are one-commit docs typo fixes, same shape as #6. Merging them closes the two remaining tickets automatically.
* **Feishu is not installed** (`feishuProblem` empty). Adding it would give a second channel where the merged/closed notices actually get posted.
* **Task Scheduler history is off** on this machine (`Microsoft-Windows-TaskScheduler/Operational` disabled); enabling it needs administrator rights, which conflicts with the non-elevated requirement. The audit trail lives in `.artifacts/control/profiles/superagent/audit.log` instead.
* **Nothing merges itself.** If you want that later, it is a policy and executor question, not a switch that exists today.

## Operating it

```powershell
# start / stop / status / restart (never needs administrator)
D:\7wenjianjia\Documents\dsh-superagent\scripts\dsh-superagent.ps1 status -GhConfigDir C:\Users\Dell\.dsh\gh\superagent -RespectStop

# read-only health check; exit 3 means a ticket is waiting for a person
D:\7wenjianjia\Documents\dsh-superagent\scripts\superagent-patrol.ps1
```

Audit lines and patrol lines:

```text
.artifacts\control\profiles\superagent\audit.log     one invoked/exit pair per script call
.artifacts\control\profiles\superagent\patrol.log    one line per patrol, exit code + counters
```

The scheduled task `dsh-superagent` runs the start half at logon and every 10 minutes, always with `-GhConfigDir` and `-RespectStop`, always as you and never elevated.