# Launch posts

Drafts for the v0.1.0 launch. Nothing here is posted until the author says yes to each post's final text. All posting is done manually by the author. Repo: https://github.com/moelsaka01/tierview

## Schedule (UAE time)

1. **Tuesday, 17:00:** Show HN, posted manually. Stay online for 2 hours to reply to comments.
2. **Friday morning, 8–10 am:** r/ClaudeAI (read the sidebar rules and check the flair first), then X, then LinkedIn. Each mentions the HN discussion if it went well (placeholder lines are marked `[HN]` in the drafts; delete them if it did not).

## Rules checked (2026-11-17)

- **Hacker News** (read on news.ycombinator.com/showhn.html): Show HN needs something people can run; it must be non-trivial and the author must be around to discuss it; title starts with "Show HN"; no asking friends to upvote or comment. `npx tierview review --dry-run` is runnable with no signup. Plan to stay in the thread for the first hours.
- **r/ClaudeAI**: the rules page could not be opened (reddit.com is blocked in the built-in browser, and web search did not return the rule text). Not verified. Before posting, read the sidebar for a self-promotion rule and any "Built with Claude" or project flair.
- **r/programming**: Skipped: subreddit restricts self-promotion and LLM topics. (Draft removed.)
- X and LinkedIn: no posting rules to check beyond their terms; these are the author's own accounts.

All posts: say that it is n = 13, p = 0.5, C-heavy test set; lead with the free path and the receipt; no "Fable-level" claim (Fable was never measured).

---

## Show HN

**Title:** `Show HN: Tierview – Claude code review that routes each hunk to a cheaper model`

**URL:** https://github.com/moelsaka01/tierview

**First comment (post it right after submitting):**

> I built tierview because I wanted code review on diffs without sending everything to the most expensive model. It scores each hunk of a diff with deterministic rules (auth, SQL, memory, boundary changes...), sends boring hunks to Sonnet at low effort and risky ones to Opus, escalates when a model is unsure or contradicts itself, and prints a cost receipt: tokens and cost per tier, plus what the same work would cost on the most expensive model.
>
> It runs on your existing Claude subscription through the official Claude Code CLI (`claude -p`), so there is no API key on the default path: `npx tierview review --dry-run` shows the routing and an estimate with zero model calls, and `npx tierview review` runs it. There is also an API-key backend and a GitHub Action.
>
> I benchmarked it on real bugs: 30 commits from 9 open-source repos (QEMU, DPDK, Django, Cilium...), where a later commit named the bug. On the 13-bug held-out test split it caught 9 vs 7 for all-Opus, with 0 false alarms on 7 clean commits (all-Opus raised 3), at 16% lower cost per case via Claude Code (7% on direct API pricing). That is n = 13 and the difference is not statistically significant (exact McNemar p = 0.5). All-Sonnet caught 4. The test set is C-heavy, each case ran once, and I marked the judge audit myself. Catches were decided by location rules first and an Opus judge for ambiguous cases. Everything is in bench/results/RESULTS.md, including a usage-limit incident I hit mid-run and how I fixed it.
>
> Things that are not done: the GitHub Action's PR comment has only been tested against mocked responses, not live; the API backend is unit-tested only; I never ran Fable, so its cost line is a calculation. Tiered routing itself is not new (d1ff and others do it); I did not find a published benchmark or a receipt like this. I would like to hear where the routing rules are wrong on your code.

---

## r/ClaudeAI

Check the sidebar rules and flair before posting.

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
> Benchmark, honestly: 13 real bugs held out, 9 caught vs 7 for all-Opus, 0 false alarms on 7 clean commits, 16% lower cost per case via Claude Code (7% on direct API pricing). n = 13, p = 0.5, so that is not significant. The set is C-heavy and each case ran once. I marked the judge audit myself; catches were decided by location rules first and an Opus judge for ambiguous cases. The benchmark itself used 190 calls on a Pro plan and hit the 5-hour limit once, so mind your limits (`--max-calls` helps).
>
> [HN] (Optional, if it went well: "There was a good discussion on Hacker News: <link>".)
>
> Repo, data and all caveats: https://github.com/moelsaka01/tierview. Built with Claude Code across several sessions; the build log is in the repo. Feedback on where it misses is welcome.

---

## X thread

1. I built tierview: code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when unsure, and prints a cost receipt. It runs on your Claude subscription. No API key. github.com/moelsaka01/tierview
2. Try it free: `npx tierview review --dry-run` shows where every hunk goes and what it would cost, with zero model calls. [demo GIF]
3. The receipt: tokens and cost per tier, plus what the same tokens would cost on the priciest model. On a plan it's API-equivalent, not your bill. [receipt screenshot]
4. Benchmark on 13 real held-out bugs: tierview caught 9, all-Opus 7, all-Sonnet 4. 0 false alarms on 7 clean commits (all-Opus: 3). 16% cheaper per case than all-Opus via Claude Code (7% on direct API pricing).
5. The caveat that matters: n = 13, exact McNemar p = 0.5. Not significant. C-heavy, one run per case, judge audit marked by me. Catches were decided by location rules first and an Opus judge for ambiguous cases. A pilot, not proof. [chart]
6. Not done yet: the GitHub Action's PR comment is untested live; I never ran Fable, so that cost is calculated. Data, limits and a usage-limit bug I hit are all in RESULTS.md. MIT. Tell me where it misses.
7. [HN] (Optional, if it went well: "Discussion on Hacker News: <link>")

---

## LinkedIn

I benchmarked Claude models on 13 real bugs. Here's what I found.

Sending each part of a diff to a model matched to its risk caught 9 of the 13 bugs. Sending everything to the strongest model caught 7, and the cheapest model alone caught 4. The tiered setup also raised no false alarms on 7 clean commits, where the strongest model raised 3, at 16% lower cost per case via Claude Code (7% on direct API pricing).

The caveats matter. With only 13 bugs the difference is not statistically significant (p = 0.5), the set leans toward C, and each case ran once. I marked the judge audit myself; catches were decided by location rules first and an Opus judge for ambiguous cases. Please read it as a pilot. The bugs came from QEMU, DPDK, Django, Cilium and others, where a later commit named the bug.

[HN] (Placeholder: one line on how the Hacker News discussion went, with the link, if it went well. Delete if not.)

The tool behind it is tierview, an open-source code reviewer. It scores each hunk with deterministic rules, sends low-risk hunks to a cheaper model and risky ones to a stronger one, escalates when a model is unsure, and prints a cost receipt per tier. It runs on an existing Claude subscription through Claude Code with no API key: `npx tierview review --dry-run` shows the routing and an estimate without making a model call.

The repo has the data, the limits, and a note on a usage-limit bug I found in my own benchmark runner before computing any metric.

Repo: https://github.com/moelsaka01/tierview
