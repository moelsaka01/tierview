# Launch posts

Drafts for the v0.1.0 launch. Nothing here is posted until the author says yes to each post's final text. Repo: https://github.com/moelsaka01/tierview

Order: Show HN first (Tuesday to Thursday, morning US Eastern, roughly 8 to 10 am ET), the rest only after it is up.

## Rules checked (2026-11-17)

- **Hacker News** (read on news.ycombinator.com/showhn.html): Show HN needs something people can run; it must be non-trivial and the author must be around to discuss it; title starts with "Show HN"; no asking friends to upvote or comment. `npx tierview review --dry-run` is runnable with no signup. Plan to stay in the thread for the first hours.
- **r/ClaudeAI**: the rules page could not be opened (reddit.com is blocked in the built-in browser, and web search did not return the rule text). Not verified. Before posting, read the sidebar for a self-promotion rule and any "Built with Claude" or project flair.
- **r/programming**: rules also not verified. Search results suggest that r/programming restricts self-promotion (one guide says Saturdays only) and that its moderators banned LLM-related discussion, which would cover this post. **Recommendation: skip r/programming unless the sidebar clearly allows it.** The text is drafted anyway.
- X and LinkedIn: no posting rules to check beyond their terms; these are the author's own accounts.

All posts: say that it is n = 13, p = 0.5; lead with the free path and the receipt; no "Fable-level" claim (Fable was never measured).

---

## Show HN

**Title:** `Show HN: Tierview – Claude code review that routes each hunk to a cheaper model`

**URL:** https://github.com/moelsaka01/tierview

**First comment (post it right after submitting):**

> I built tierview because I wanted code review on diffs without sending everything to the most expensive model. It scores each hunk of a diff with deterministic rules (auth, SQL, memory, boundary changes...), sends boring hunks to Sonnet at low effort and risky ones to Opus, escalates when a model is unsure or contradicts itself, and prints a cost receipt: tokens and cost per tier, plus what the same work would cost on the most expensive model.
>
> It runs on your existing Claude subscription through the official Claude Code CLI (`claude -p`), so there is no API key on the default path: `npx tierview review --dry-run` shows the routing and an estimate with zero model calls, and `npx tierview review` runs it. There is also an API-key backend and a GitHub Action.
>
> I benchmarked it on real bugs: 30 commits from 9 open-source repos (QEMU, DPDK, Django, Cilium...), where a later commit named the bug. On the 13-bug held-out test split it caught 9 vs 7 for all-Opus, with 0 false alarms on 7 clean commits (all-Opus raised 3), at 16% lower cost per case. That is n = 13 and the difference is not statistically significant (exact McNemar p = 0.5). All-Sonnet caught 4. The test set is C-heavy, each case ran once, and I marked the judge audit myself. Everything is in bench/results/RESULTS.md, including a usage-limit incident I hit mid-run and how I fixed it.
>
> Things that are not done: the GitHub Action's PR comment has only been tested against mocked responses, not live; the API backend is unit-tested only; I never ran Fable, so its cost line is a calculation. Tiered routing itself is not new (d1ff and others do it); I did not find a published benchmark or a receipt like this. I would like to hear where the routing rules are wrong on your code.

---

## r/ClaudeAI

**Title:** `I built a code reviewer that runs on your Claude subscription (no API key) and prints a cost receipt`

> tierview reviews a git diff by sending each hunk to the cheapest Claude model that can handle it: Sonnet 5.5 at low effort for boring hunks, Opus 5.5 for risky ones, with escalation when a model is unsure. It runs through Claude Code (`claude -p`), so it uses the plan you already have. No API key.
>
> ```
> npx tierview review --dry-run   # zero model calls: routing + estimated cost
> npx tierview review             # the real review
> ```
>
> After each run it prints a receipt: tokens and API-equivalent cost per tier, and what the same tokens would cost on Fable. (On a plan that is API-equivalent, not what you were billed.) Fable is opt-in, because on some plans `claude -p` bills it as extra usage without asking.
>
> Benchmark, honestly: 13 real bugs held out, 9 caught vs 7 for all-Opus, 0 false alarms on 7 clean commits, 16% lower cost per case. n = 13, p = 0.5, so that is not significant. The set is C-heavy and each case ran once. The benchmark itself used 190 calls on a Pro plan and hit the 5-hour limit once, so mind your limits (`--max-calls` helps).
>
> Repo, data and all caveats: https://github.com/moelsaka01/tierview. Built with Claude Code across several sessions; the build log is in the repo. Feedback on where it misses is welcome.

---

## r/programming (only if the sidebar allows it; otherwise skip)

**Title:** `A small benchmark of tiered vs single-model LLM code review on 13 real bugs (9 vs 7, p = 0.5)`

> I wrote a CLI that routes each hunk of a diff to a cheaper or stronger model by deterministic risk rules, then measured it against all-strong-model and all-cheap-model baselines on commits where a later commit named the bug. The honest summary: on 13 held-out bugs the tiered setup caught 9, all-Opus 7, all-Sonnet 4; 0 false alarms vs 3 of 7 clean commits for all-Opus; 16% lower cost. n = 13, exact McNemar p = 0.5, C-heavy, single runs, author-marked judge audit. Treat it as a pilot. The cases, raw runs and judge decisions are in the repo, and a bug in my runner that would have counted failed calls as clean reviews is written up too.
>
> https://github.com/moelsaka01/tierview (MIT; runs on a Claude subscription via Claude Code, or with an API key)

---

## X thread

1. I built tierview: code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when unsure, and prints a cost receipt. It runs on your Claude subscription. No API key. github.com/moelsaka01/tierview
2. Try it free: `npx tierview review --dry-run` shows where every hunk goes and what it would cost, with zero model calls. [demo GIF]
3. The receipt: tokens and cost per tier, plus what the same tokens would cost on the priciest model. On a plan it's API-equivalent, not your bill. [receipt screenshot]
4. Benchmark on 13 real held-out bugs: tierview caught 9, all-Opus 7, all-Sonnet 4. 0 false alarms on 7 clean commits (all-Opus: 3). 16% cheaper per case than all-Opus.
5. The caveat that matters: n = 13, exact McNemar p = 0.5. Not significant. C-heavy, one run per case, judge audit marked by me. A pilot, not proof. [chart]
6. Not done yet: the GitHub Action's PR comment is untested live; I never ran Fable, so that cost is calculated. Data, limits and a usage-limit bug I hit are all in RESULTS.md. MIT. Tell me where it misses.

---

## LinkedIn

I released tierview, an open-source code reviewer for Claude that tries to spend less on easy changes.

It scores each hunk of a diff with deterministic rules, sends low-risk hunks to a cheaper model and risky ones to a stronger one, escalates when a model is unsure, and prints a cost receipt showing what each tier cost.

It runs on an existing Claude subscription through Claude Code, with no API key: `npx tierview review --dry-run` shows the routing and an estimate without making a model call.

I tested it on real bugs from QEMU, DPDK, Django, Cilium and others. On 13 held-out bugs it caught 9, against 7 for sending everything to the strongest model, with no false alarms on 7 clean commits, at 16% lower cost per case. With only 13 bugs the difference is not statistically significant (p = 0.5), the set leans toward C, and each case ran once, so please read it as a pilot. The repo has the data, the limits, and a note on a usage-limit bug I found in my own benchmark runner before computing any metric.

Repo: https://github.com/moelsaka01/tierview
