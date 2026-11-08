# dsh-superagent on Windows (native, no WSL)

Installed from github.com/deepseek-ai/dsh-superagent-prototype @ 8c32a9d, patched for Windows, built locally, loaded into a dedicated DSH profile.

## What is where

| Thing | Path |
| --- | --- |
| Source (git, patched) | `D:\7wenjianjia\Documents\dsh-superagent` |
| Built bundle | `D:\7wenjianjia\Documents\dsh-superagent\lib\index.js` (linked into the profile) |
| DSH profile | `C:\Users\Dell\.dsh\profiles\superagent` |
| State, tickets, worktrees | `C:\Users\Dell\.dsh\state\superagent` (work root `...\work`) |
| Service identity token | `C:\Users\Dell\.dsh\secrets\superagent-gh-token.txt` (optional) |
| Logs | `D:\7wenjianjia\Documents\dsh-superagent\.artifacts\dsh-superagent-superagent-<stamp>-<pid>.log` |
| Control script | `D:\7wenjianjia\Documents\dsh-superagent\scripts\dsh-superagent.ps1` |
| Identity helper | `D:\7wenjianjia\Documents\dsh-superagent\scripts\set-superagent-identity.ps1` |
| Panel | <http://127.0.0.1:3082/> — token is the `?token=...` of the newest `dsh web: ...` log line |

The POSIX launcher `scripts/dsh-superagent` (Python: `fcntl`, `tmux`, `ps`, `umask`) cannot run on Windows; the two `.ps1` scripts above replace it.

`DSH_HOME` on this machine is `D:\7wenjianjia\Documents\deepseek-harness\dsh-home`, and `C:\Users\Dell\.dsh` is a directory junction to it, so both spellings above reach the same files. The profile really lives under `$DSH_HOME\profiles\superagent`, and `--dump-config` reports the D: path as the source of its patch layer.

## Operate

```powershell
$s = 'D:\7wenjianjia\Documents\dsh-superagent\scripts\dsh-superagent.ps1'
& $s status     # 0 healthy, 1 not running/unreachable, 2 a part reports an error, 3 waiting for setup
& $s start      # -TimeoutSeconds 90, -RespectStop to honour an intentional stop
& $s stop       # also clears the leftover proper-lockfile lock
& $s restart
```

Port, profile, state directory and identity come from `-Url`, `-ProfileName`, `-StateDir`, `-GitHubTokenFile`, `-GhConfigDir` (or `DSH_SUPERAGENT_URL`, `DSH_SUPERAGENT_PROFILE`, `DSH_SUPERAGENT_STATE_DIR`, `DSH_SUPERAGENT_GH_TOKEN_FILE`, `DSH_SUPERAGENT_GH_CONFIG_DIR`).

## GitHub identity (who the agent acts as)

By default the service inherits the interactive `gh` login — the same account you push from. Two ways to separate it, both handled by `set-superagent-identity.ps1` and by the control script's start:

1. **A token file** (`C:\Users\Dell\.dsh\secrets\superagent-gh-token.txt`). `start` exports its contents as `GH_TOKEN` to the whole service process, so the orchestrator, every Source, every Executor Session and every `git`/`gh` child inherits it. Use a **fine-grained token scoped to `xielhz/superagent-sandbox` only** (Contents RW, Issues RW, Pull requests RW, Metadata R) — then even a rogue agent cannot touch any other repository.
   ```powershell
   & 'D:\7wenjianjia\Documents\dsh-superagent\scripts\set-superagent-identity.ps1' -Token <pat>
   & 'D:\7wenjianjia\Documents\dsh-superagent\scripts\set-superagent-identity.ps1' -Clear   # back to the interactive login
   ```
   The helper validates the token before writing it, checks `permissions.push` on the repository, stores it readable by this account only, and restarts the service.
2. **A `GH_CONFIG_DIR` of its own** (fullest separation: a second, dedicated GitHub account signed in with `gh auth login` under that directory). `start -GhConfigDir <path>` prefers it over the token file; the account is then a different actor entirely, and commits carry its identity.

`status` reports which one is in force as `github_identity`: `{"via":"token ...","isolated":true}` or `{"via":"interactive gh login","isolated":false}`.

## Settings

Management API only (the panel uses it too):

```powershell
$h = @{'x-orchestrator-request'='1'}
Invoke-WebRequest 'http://127.0.0.1:3082/orchestrator/api/state'    -Headers $h -UseBasicParsing
Invoke-WebRequest 'http://127.0.0.1:3082/orchestrator/api/settings' -Headers $h -UseBasicParsing
# PUT /orchestrator/api/settings/{policy|eval|executor|source:github}  body {"value":..., "revision":<current>}
```

Two traps found the hard way:
* `Set-Content -Encoding UTF8` writes a BOM and the server answers `{"error":"The request body is not JSON"}`. Write the body with `[System.IO.File]::WriteAllText($p,$json,(New-Object System.Text.UTF8Encoding($false)))` and send it with `curl.exe --data-binary "@$p"`.
* A GitHub account in `policy.sources.github.allowed` takes `{"id":"<login>"}` only; adding `name` is rejected with `Unrecognized key: "name"`.

Current configuration:

* Source GitHub: repository `xielhz/superagent-sandbox` (**private**, created for this), agent CLI `C:\Program Files\GitHub CLI\gh.exe`, poll 60 s, `observeIssues` and `observeComments` **on** (so threads that never mention the bot still reach the assessment), `observePulls` and `observeCi` off.
* Policy: rules `copy` and `visual`; allowed accounts for github = `xielhz`.
* Eval: **`auto`** since this run, `timeoutSeconds` 600 (the maximum allowed), `model` null (falls back to the profile's `agent-default-model`). A candidate that a rule matches is now executed; `observe` would record it instead. An explicit `@mention` is routed straight to a worker regardless of `mode`.
* Executor: default model, 3 workers, directory empty (`C:\Users\Dell\.dsh\state\superagent\work`), no prepare command, nothing blocked.

## Windows patches applied to the source

`src/deployment.ts` — `ABSOLUTE = WIN ? /^([A-Za-z]:[\\/]|\/)/ : /^\//` used by `absolute()` (it rejected `C:\...` and made every `stateDir` invalid); `workerProbe` no longer prefixes `['env', 'PATH=...']` (no `env` on Windows) and bounds the probe with `AbortSignal.any([signal, AbortSignal.timeout(60_000)])`; the Feishu probe is split per platform.

`src/infra/environment.ts` — shims are `.cmd` files instead of `#!/bin/sh` scripts, the marker is matched anywhere in the first lines, the credential helper is `!"<cli>" auth git-credential`, and `git --show-origin` output is compared after normalising separators and case.

`src/app/sessions.ts` — the orchestrator Session restricted tools by the literal name `bash`, which DSH on Windows does not have: `tools.restrict() names unknown global tool "bash"` aborted the whole plugin (management API 404). It now restricts `process.platform === 'win32' ? 'pwsh' : 'bash'`, and the "do not wait" guard recognises `pwsh` as the shell too.

`src/policy.ts` — `executor.directory` accepted only paths starting with `/`; it now accepts a drive letter as well.

Rebuild after any source change (the profile links the source, so only a restart is needed):

```powershell
$nodeDir = 'C:\Users\Dell\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$env:PATH = $nodeDir + ';' + $env:PATH
& "$nodeDir\node.exe" 'C:\Users\Dell\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' run build
```

## Still open

* Feishu Source: not installed, `feishuProblem` is empty.
* Two PRs are open and waiting for a person to merge: #3 (`docs/notes.md`) and #4 (`docs/guide.md`). The agent never merges on its own; the ticket parks at stage `person` with action `review`. PR #6 (`docs/faq.md`) was merged by hand and its ticket closed with outcome `merged` (see below).
* The system-level task history (`Microsoft-Windows-TaskScheduler/Operational`) is disabled on this machine. Enabling it needs administrator rights, which conflicts with the non-elevated requirement, so the audit trail currently lives in `audit.log` (see below).
* A ticket that reported `waiting` (not `ready`) sits at stage `idle` with no retry button even though its PR is open - it needs a comment on its own thread. See `## A ticket that goes quiet` below.
* `OVERNIGHT-REPORT.md` records the unattended run: what was proven, the two source bugs fixed, and what a person still has to do.

## The two identities on this machine (as installed)

| role | account | gh config dir | storage |
| --- | --- | --- | --- |
| person | `xielhz` (id 43595642) | `%APPDATA%\GitHub CLI` | OS keyring |
| agent (bot) | `lhz-agent` (id 353752974) | `C:\Users\Dell\.dsh\gh\superagent` | plain text in that dir's `hosts.yml` (`gh auth login --insecure-storage`) |

**Do not store both in the keyring.** `gh` keeps one keyring slot, so `gh auth logout` in one
config dir revokes the token the other dir is using - that is exactly how the initial setup broke
(`X Failed to log in to github.com account xielhz (default) - The token in default is invalid`, and the
plugin then reported `agentCliSignedOut` after hitting `gh: API rate limit exceeded`). Always log a
second identity in with `--insecure-storage` so its token lives in its own `hosts.yml`.

`scripts/login-github-accounts.ps1` does both halves (`-Only me` / `-Only bot`);
`scripts/set-superagent-identity.ps1 -Token <pat>` remains the no-second-account fallback.

Start the service as the bot with:

```powershell
& 'D:\7wenjianjia\Documents\dsh-superagent\scripts\dsh-superagent.ps1' start -GhConfigDir 'C:\Users\Dell\.dsh\gh\superagent'
```

## Autostart and watchdog (scheduled task `dsh-superagent`)

The task satisfies three hard requirements: **the current, non-elevated user**, **only this script with its two mandatory arguments**, and **an auditable trail**.

| Aspect | Value |
| --- | --- |
| Principal | `DESKTOP-N73NUIG\Dell`, `LogonType=Interactive`, `RunLevel=Limited` (never elevated) |
| Action | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\dsh-superagent.ps1" start -ProfileName superagent -Url http://127.0.0.1:3082 -TimeoutSeconds 90 -GhConfigDir "C:\Users\Dell\.dsh\gh\superagent" -RespectStop` |
| Triggers | at logon, plus every 10 minutes |
| Settings | `MultipleInstances=IgnoreNew`, `StartWhenAvailable`, run on battery, `ExecutionTimeLimit=30min` |

`-RespectStop` is what keeps a deliberate `stop` respected: `stop` drops a marker, `start -RespectStop` sees it and exits 0 without reviving the service, while a crash (no marker) is restarted within ten minutes.

Re-register it with:

```powershell
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\7wenjianjia\Documents\dsh-superagent\scripts\dsh-superagent.ps1" start -ProfileName superagent -Url http://127.0.0.1:3082 -TimeoutSeconds 90 -GhConfigDir "C:\Users\Dell\.dsh\gh\superagent" -RespectStop')
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$pr = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$st = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'dsh-superagent' -Action $act -Trigger @($t1,$t2) -Principal $pr -Settings $st -Force
```

### Audit trail

Every invocation appends two lines to `.artifacts\control\profiles\superagent\audit.log`: one on entry (`invoked`) and one on exit (`exit=<code>`), with the time, PID, user, action, and the parameters actually used:

```text
2026-11-07T22:33:48.130133 pid=12052 user=Dell action=start profile=superagent url=http://127.0.0.1:3082 ghConfigDir=C:\Users\Dell\.dsh\gh\superagent respectStop=True invoked
2026-11-07T22:33:48.813516 pid=12052 user=Dell action=start profile=superagent url=http://127.0.0.1:3082 ghConfigDir=C:\Users\Dell\.dsh\gh\superagent respectStop=True exit=0
```

The exit line also carries a health snapshot whenever the management API answered, which turns `audit.log` into a health trail at the scheduled task's cadence (every ten minutes here) - no separate monitor needed:

```text
2026-11-08T02:56:45.1508051 pid=50200 user=Dell action=start profile=superagent url=http://127.0.0.1:3082 ghConfigDir=C:\Users\Dell\.dsh\gh\superagent respectStop=True exit=0 health=runtime:ready,relay:ready,notice:ready,launch:ready,delivery:ready,assessment:ready,reply:ready,evals:ready,models:ready,github:ready
```

A terminating error is recorded too (`error=<message>`, exit 1), so a run never disappears silently. `superagent-patrol.ps1` is the finer-grained check (it also notices a ticket waiting at `person` and a stale lock); the audit line is what proves the schedule itself kept running.

## Model access: the profile needs its own provider

The orchestrator Session, the assessment and every worker call a model through the profile **it** boots, not through the desktop profile. A profile created with `--from-default-profile web` has no provider configured, so the default route `deepseek-official` fails with:

```text
llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials
service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment   [MISSING_CREDENTIAL]
```

The symptom at the panel is not an error but silence: every evaluation ends as `unavailable / timeout`, because the session that should judge the candidate can never answer.

Copy the routes you already use into the profile's patch (`$DSH_HOME\profiles\superagent\cordis.patch.yml`). The credentials stay in `$DSH_HOME\.credentials.yaml`; the patch only names them:

```yaml
- id: llm-pi-ai
  config:
    providers:
      a6api:
        api: openai-completions
        apiKeyEnv: A6API_API_KEY
        baseURL: https://api.a6api.vip
        models:
          - id: deepseek-v4.1-flash-1017
            name: deepseek-v4.1-flash-1017
            reasoningEfforts: { off: null, low: low, medium: medium, high: high }
            input: [text, image]
- id: agent-default-model
  config:
    provider: a6api
    model: deepseek-v4.1-flash-1017
    reasoningEffort: high
```

Verify before restarting: `dsh --profile superagent --dump-config` must show the providers merged into `llm-pi-ai`.

## Troubleshooting: every evaluation times out

Two independent causes, both seen here; check them in this order.

1. **The persisted `master-id` points at a session that cannot be loaded.** Evaluations are delivered to the main Session as a candidate card, and the id lives in `kv` of `orchestrator.sqlite`. Because it survives restarts, a stale id means every delivery fails and retries until the deadline - the panel shows `eval-unavailable` with `reason: timeout` forever, and no Session directory appears under `$DSH_HOME\sessions\...`.
   Fix (no data loss): stop the service, back up `orchestrator.sqlite`, set `kv['master-id']` to a fresh `orchestrator-<32 hex>`, start again. Settings, tickets and history are untouched.
2. **No model provider in this profile** - see the section above. The giveaway is a Session file whose turn ends with `MISSING_CREDENTIAL` on the first step.

How to read a Session file: `session.v4.jsonl.zstd` is a concatenation of zstd frames, and a one-shot `zstdDecompressSync` returns only the first frame (which looks like a single header line). Scan for the magic `0x28 0xB5 0x2F 0xFD` and decompress each frame to see the whole history.

## Verified end to end

Three routing paths, all exercised on the same sandbox repository.

**1. An explicit `@mention`** is routed straight to a worker, with no assessment:

```text
xielhz   16:39:22Z  @lhz-agent 冒烟测试（第 8 次…）：请只回复“收到”，不要修改任何文件。
lhz-agent 16:39:54Z  收到 <!-- dsh-superagent:5038407edc1889c1d5baf8c93f61dd3c -->
```

`ticket 2c901963c9a66bd7d44386c66fa89eff` ended by the executor as `completed`, decision `kind: accept, reason: explicitRouted`.

**2. A follow-up on a thread that already has a ticket** joins that ticket (basis `via: followup`). If the worker judges it outside the ticket's scope it hands it back - the note read, verbatim, `本票据范围仅为 docs/notes.md 的四处拼写修正；该请求要求修改另一个文件 docs/guide.md` - and the engine opens a new ticket for it (PR #4).

**3. An observed request - no mention, a thread with no ticket** goes through the assessment with the policy rules. This is the path `eval.mode` controls. With `eval.mode = auto` and the `copy` rule enabled:

```json
{"kind":"accept","reason":{"code":"said","values":{"text":"Issue 明确要求修正本仓库 docs/faq.md 的两处拼写并给出替换词，符合 Copy fixes 规则且属小型本地修改。"}},
 "audit":{"matches":[{"rule_id":"copy","reason":"Issue 明确请求修正 docs/faq.md 的拼写：teh→the、recieves→receives，并指定其它内容不动，属拼写更正。"}]}}
```

The executor then forks a worktree, commits, pushes a branch and opens a PR - never pushing to `main` - and the ticket parks at stage `person` with action `review` until a human merges:

| Ticket | Trigger | Result |
| --- | --- | --- |
| `e6c775cafe409621141d6a90f90b7e04` 修正 docs/notes.md | explicit mention | branch `agent/fix-notes-typos-e6c775cafe40`, commit `30abb05`, PR #3 |
| `35807990…` 修正 docs/guide.md | follow-up → handback | branch `agent/fix-guide-typos-35807990c355`, PR #4 |
| `ad2930bd…` 修正 docs/faq.md | **rule-judged (copy)** | branch `agent/fix-faq-typos-ad2930bdb99a`, PR #6 |

## Notification and comment lookback (a source bug fixed here)

The Source polled `notifications?all=true&since=<cursor>` and advanced that cursor to the start of each round, then filtered comments with `timestamp < since`. GitHub indexes a notification a moment after the comment exists, so a comment written just before a round but indexed just after it was never seen: the next round asked for a later `since`, and the item was gone for good. Symptom: `/orchestrator/api/sources` reports `0 notifications` while `gh api notifications` for the same token still lists the mention; the ticket never appears.

The fix re-reads a 180 s window (`src/sources/github.ts`):

```ts
const LOOKBACK_MS = 180_000
const lookback = (at: string): string => new Date(Date.parse(at) - LOOKBACK_MS).toISOString()
const since = lookback(state.get(KV.github.since) ?? round.started)
items.set(number, { since: lookback([state.get(KV.github.cursor(number)) ?? since, since].sort().at(-1)!), pr })
```

Re-reading is harmless: a Trigger's ID is derived from its content (`key('github-comment', url, String(comment.id), version)`), so the same comment produces the same ID and is not ingested twice.

Two more source facts worth knowing: an Issue **body** only counts when the Issue is opened after the cursor (a mention added later by editing the body produces nothing - comment instead), and `observeIssues` / `observeComments` in the Source settings are what make non-mention threads reachable at all.

## A refusals path, verified: eval.mode = auto is not "run anything"

Rule-judged requests can also be **refused**, and that is the half that matters for unattended running. Issue #7 asked for something outside every enabled rule - create `docs/CHANGELOG.md`, regroup `docs/` into `guides/` and `reference/` - and the engine produced a decision, not a ticket:

```json
{"kind":"ignore","reason":[
  {"code":"ignoredFromCard"},
  {"code":"said","values":{"text":"请求是文档目录重组（guides/ 与 reference/）并新增语义化版本 CHANGELOG，不属拼写/文案更正或视觉修正规则，也超出小型本地修改的范围，需人工规划。"}}]}
```

`ignoredFromCard` is the machine-readable half (`ignore` + code); the `said` entry is the model's own justification, stored in the decision row. The ticket count stayed at 4, so nothing was forked, no branch pushed, no PR opened. The counters moved the way they should: `received 10 -> triggers 10 -> judged 9 -> accepted 4` - one more observation, one more judgement, the same number of accepted tickets.

Read together with path 3 above, this is the useful pair of facts about `eval.mode: auto`:

| Request | Decision | Side effects |
| --- | --- | --- |
| spelling fix with explicit replacements (Issue #5) | `accept`, matched rule `copy` | branch + PR #6 |
| doc restructure + new changelog (Issue #7) | `ignore`, `ignoredFromCard` | none |

Both carry a written reason. When a decision looks wrong, read it before touching settings: `select value from decision order by rowid desc` in `orchestrator.sqlite` holds `kind` and the full `reason` array.

## Crash recovery, measured

Killing the host without the stop marker is exactly the case the scheduled task exists for. `Stop-Process -Id 39396 -Force`, then:

```text
port 3082       no listener, stale superagent.lock left behind
Start-ScheduledTask dsh-superagent
01:55:26.627    audit: action=start ... respectStop=True exit=0   (pid 31696)
01:56:38        status: pids=49156 runtime=ready github=ready account=lhz-agent
```

Ninety seconds from kill to a serving instance, with ticket state intact - the status database is the source of truth, and the script removes the stale lock before starting.

## Merging the pull request is what closes the ticket

The last unverified link in the loop was the human one: a ticket parks at stage `person`, action `review`, and waits. It leaves that stage when the PR it opened is merged or closed - but only if the Source watches pull requests, because the state change is discovered by polling, not pushed:

```powershell
PUT /orchestrator/api/settings/source:github   revision 3 -> 4
{"value":{"enabled":true,"config":{...,"observePulls":true}}}
-> {"saved":true,"revision":4,"policy_changed":false,"restarting":false,"context_delivery":"injected"}
```

Then merges PR #6 by hand (squash, commit `7bb336b`). Within one poll the ticket ended:

```json
follows: [{"thread":"github:6","own":true,"closed":{"at":"2026-11-07T18:20:51.000Z","outcome":"merged"}}]
ended:        {"at":"2026-11-07T18:20:51.000Z","by":"executor","outcome":"merged"}
```

and it disappeared from `GET /orchestrator/api/tickets` (2 open tickets left). `TicketOutcome` has five values - `completed`, `merged`, `closed`, `dropped`, `stopped` - so "merged" and "closed unmerged" are distinguishable in the record.

**No comment is posted on GitHub when a PR ends, by design.** `pullEndNotices` in `src/sources/github-pull.ts` returns notices only for non-GitHub channels: "GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped." With only a GitHub Source installed, a merged PR therefore produces no reply - that is expected, not a delivery failure. The IM path would say `[PR #6](url) 已合并。`

### Operational lessons from this step

* Reading a ticket means reading JSON out of a two-column table: `ticket` is `(id, value)` and `value` is the whole record. A query like `select state, stage, outcome from ticket` fails with `no such column: state`; select `value` and parse it.
* `GET /orchestrator/api/tickets` returns `{items:[...]}`, and `GET /orchestrator/api/sources` returns an array of `{id,installed,enabled,state,health:[{name,state,detail,at}],stats:{received,filtered,lastAt}}`.
* **Do not drive GitHub REST through `curl.exe` or `gh` from this harness.** Three `curl -X PUT .../pulls/6/merge` attempts and two `gh pr merge` attempts each hit the 120 s tool deadline (a stale `gh` process survived; `GET /rate_limit` meanwhile answered in 733 ms). The same merge through Node`s `fetch` inside `run_code` returned in 3.4 s. `gh` is still the right tool for the agent`s own work, where the plugin spawns it directly - it is only this harness`s foreground invocation that stalls.
* `pwsh` calls carry roughly 30 s of startup overhead here; wrap the GitHub calls in `run_code` with `fetch` instead.

## A ticket that goes quiet: `idle` is not `review`

Two tickets sat at stage `idle` for over an hour while their pull requests were open and unmerged. Nothing was broken - the stage table in `src/core/stage.ts` says a ticket whose worker reported `waiting` is `idle`, not `person/review`; only a `ready` report parks it for review:

```text
ended                                              -> ended
delivery / attention                               -> person/delivery, person/answer
report.state === "ready"                           -> person/review      <- waits for a person
"blocked" | "failed" and waitsForPerson(ticket)    -> person/blocked|failed
no assignment, or assignment.state === "pending"   -> working/queued
report.state === "waiting" or state === "ended"    -> idle               <- waits for nobody
```

The guide ticket had reported `waiting` with the summary `PR #4 opened from branch agent/fix-guide-typos-35807990c355: ... verifying checks and self-review before ready` - the worker ended its turn mid-self-check, and since `report: waiting` is not `blocked`/`failed`, `canRetry()` is false: no button, no alarm, just silence.

The wake-up is a human comment on the thread the ticket follows. One comment on each PR thread did it:

```text
02:30:56  xielhz on PR #4: 请继续：自检通过后请报告 ready，等待人工合并。
02:32      ticket 35807990  stage person / review
02:33:32  xielhz on PR #3  -> trigger ingested, delivered to assignment fef5d38f
02:35      ticket e6c775ca  stage person / review
```

So the operational rule for an unattended run: a ticket is genuinely waiting on a person only when it says `person/review`. An `idle` ticket with an open PR needs a nudge on its own thread. `GET /orchestrator/api/tickets` shows both the stage and the ticket id, and `superagent-patrol.ps1` counts `person/review` tickets but does not know about `idle`+open-PR ones - check that pair by hand.

## Patrol

`scripts/superagent-patrol.ps1` is a read-only health check. It asks the management API for state, flow, tickets and the executor queue, checks the listener and the lock file, appends one line to `.artifacts/control/profiles/superagent/patrol.log`, and exits:

| exit | meaning |
| --- | --- |
| 0 | healthy |
| 1 | not running (or a stale lock with no listener) |
| 2 | a component reports a problem, or the API does not answer |
| 3 | healthy but something needs a person: a ticket at `person`, or the queue backing up |

```text
exit=0 pid=49156 | components ok | flow received=10 triggers=10 judged=9 accepted=4 evaluating=0 | executor running=0 queued=0 idle=2 | tickets open=2 awaiting-person=0 | lock held (expected while running)
```

It never starts, stops or reconfigures anything - the scheduled task remains the only thing allowed to act.

## Planned stop and start (the manual-stop marker)

`stop` is not the same as a crash: it writes a marker, and the scheduled task then refuses to revive the service on purpose. Verified end to end at 02:44:

```text
dsh-superagent.ps1 stop                 -> "dsh-superagent stopped. Automatic recovery is paused until start/restart."  exit 0
marker <control>\manually-stopped = True, no listener
dsh-superagent.ps1 start -RespectStop   -> "Intentional stop is active; automatic recovery skipped."  exit 0, still no listener
dsh-superagent.ps1 start                -> exit 0, marker cleared, new pid 51700
```

After the restart everything came back from the status database, not from memory: flow counters identical (`received 12, triggers 12, judged 9, accepted 4`), both tickets still at `person/review`, all ten components `ready`, `problems: []`, identity still `lhz-agent`. Only the web token in the log changes.

So the three shutdown modes are distinct and each behaves as intended:

| what happened | marker | next scheduled run |
| --- | --- | --- |
| crash / kill | none | restarts the service |
| `stop` (deliberate) | `<control>\manually-stopped` | refuses (`-RespectStop`), exits 0 |
| `start` / `restart` | cleared | restarts as usual |

Two small script details this exposed: the marker lives next to the audit log (`$control`), not beside the state directory, and `start` prints nothing on success - read the exit code, or call `status` afterwards.

## Telegram as a Source of its own

The plugin does not use `dsh-connect`; it carries its own Telegram Source so the agent talks to a bot with its own credentials. `src/sources/telegram.ts` defines the kind, `telegram-trigger.ts` normalises Bot API updates into Triggers, and `telegram-channel.ts` posts replies.

```text
src/sources/telegram.ts          SourceKind + getUpdates long-poll + Cordis entry (dsh-superagent-telegram)
src/sources/telegram-trigger.ts  Update schema, thread/channel/id derivation, mentions()
src/sources/telegram-context.ts  the cached chat window, and telegramThreadContext for assessments
src/sources/telegram-channel.ts  sendMessage, the notification mirror, t.me deep links
tsdown.config.ts                 entry 'telegram-watch' -> lib/telegram-watch.js
cordis.patch.yml                 - id: dsh-superagent-telegram / name: dsh-superagent/telegram-watch
```

Behaviour worth knowing:

* **The token never enters settings.** The Source reads it from `tokenFile` (default `C:\Users\Dell\.dsh\secrets\superagent-telegram-token.txt`); the settings JSON only stores that path. Delete the file and the Source drops to `paused` instead of failing.
* **A private message is `addressed: direct`; a group message must mention `@<botUsername>`** to be `mention`. Both become explicit mandates; everything else is an inferred candidate for the Policy's admission table.
* **`threading` decides how one chat splits into Threads, and a Thread can hold its own Ticket.** `chat` (the default) keeps the whole chat on `telegram:<chatId>`; `topic` gives each forum topic its own Thread `telegram:<chatId>:t:<message_thread_id>`, so one topic is one conversation and one Ticket and topics run in parallel; `reply` joins a reply chain on `telegram:<chatId>:r:<replied-to message>`; `message` starts a Thread per message, `telegram:<chatId>:m:<messageId>`, the closest to Feishu. Plain messages in a chat that the mode does not separate stay on `telegram:<chatId>`. The Thread's label in the panel names its topic, reply or message.
* **`notifyChatId` mirrors every reply into a channel or group** (negative IDs such as `-1001234567890` for channels and supergroups), so people following a channel see the progress without that channel being the one that asked. The mirror is the same text, never a reply, and only when it targets another chat; a failed mirror leaves the reply that was sent alone, and an empty setting turns it off.
* **Channel posts are read but never worked on.** `channel_post` and `edited_channel_post` are in `allowed_updates`; they record `telegram:<channelId>` as a Thread and keep the post in its chat's window, so the notification channel can be found in the panel, but they become no Trigger.
* **Assessments read the messages the Source cached.** The Bot API serves no history, so each poll round appends what it reads to `telegram-context:<chatId>` (the last 20 messages of that chat, sender and time included) and `telegramThreadContext` serves a Thread out of that window. A Thread that holds a single message (every message of `message` mode, or a reply nobody answered) reads the chat it was said in instead, so an assessment still sees what came before.
* **Trigger IDs are content hashes** (`key('telegram-message', chatId, messageId, editDate)`), so re-reading a message is a no-op while an edit counts as a new event.
* **The first poll drains the backlog** with `getUpdates{offset:-1,limit:1}` so a fresh install does not replay old chat.
* **Messages are plain text** and pass through `checkedImText` (100-word IM limit), so no parse mode can break; rich cards are a later phase.
* **Only one process may poll a bot.** A second `getUpdates` consumer (another profile, a test script) gets HTTP 409.

### Verified end to end (2026-11-08)

```text
11:48:15  /start   -> trigger, decision ignore [not_a_member]      (no allowlist entry yet)
11:48:20  你好      -> trigger, decision ignore [not_a_member]
11:51:16  request   -> trigger addressed:direct, decision accept [explicitRouted]
11:51:40  ticket 439a0980 '冒烟测试：仅回复“收到”，不修改文件' ended [dropped]
          outbox telegram:5049932739 status=sent text='收到'
```

`dropped` rather than `completed` is the executor saying there was nothing to change - the request was only to reply. The reply reached the chat through `sendMessage`, and `outbox.status` is `sent`, which the channel only returns when Telegram answers `ok`.

Allowlisting a Telegram user is a Policy write, not a Source write:

```powershell
PUT /orchestrator/api/settings/policy   {value:{...,sources:{telegram:{allowed:[{id:'5049932739'}]}}},revision:1}
-> {"saved":true,"revision":2,"policy_changed":true}
```

Until that entry exists, every message from that account is recorded as `ignore` with reason `not_a_member` - which is exactly what the first two messages above show.
