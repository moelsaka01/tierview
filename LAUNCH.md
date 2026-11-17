# Launch posts

Drafts for the v0.1.0 launch. Nothing here is posted until the author says yes to each post's final text. All posting is done manually by the author. Repo: https://github.com/moelsaka01/tierview

## Schedule (UAE time)

1. **Friday morning, 8–10 am:** r/ClaudeAI (read the sidebar rules and check the flair first), then X, then LinkedIn.
2. **After Friday:** the dev.to article (below), whenever it is ready to publish.
3. **From 2026-11-30:** the awesome-claude-code recommendation (below). It is not eligible before the repo is 14 days old.
4. **Show HN: postponed to a later date.** Hacker News blocks Show HN from new accounts, so it waits until the account can post it. The draft below is kept as it is; re-check the numbers and the "Things that are not done" paragraph on the day.

## Rules checked (2026-11-17)

- **Hacker News** (read on news.ycombinator.com/showhn.html): Show HN needs something people can run; it must be non-trivial and the author must be around to discuss it; title starts with "Show HN"; no asking friends to upvote or comment. `npx tierview review --dry-run` is runnable with no signup. Plan to stay in the thread for the first hours.
- **r/ClaudeAI**: the rules page could not be opened (reddit.com is blocked in the built-in browser, and web search did not return the rule text). Not verified. Before posting, read the sidebar for a self-promotion rule and any "Built with Claude" or project flair.
- **r/programming**: Skipped: subreddit restricts self-promotion and LLM topics. (Draft removed.)
- **dev.to**: no rule found that blocks a technical article about one's own project; re-check dev.to's current community guidelines before publishing.
- **awesome-claude-code**: see its section below (14-day or 100-star eligibility, human submission through the web form).
- X and LinkedIn: no posting rules to check beyond their terms; these are the author's own accounts.

All posts: say that it is n = 13, p = 0.5, C-heavy test set; lead with the free path and the receipt; no "Fable-level" claim (Fable was never measured).

---

## Show HN (postponed: new accounts cannot post Show HN)

Kept for later; not part of the Friday posts.

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
> Repo, data and all caveats: https://github.com/moelsaka01/tierview. Built with Claude Code across several sessions; the build log is in the repo. Feedback on where it misses is welcome.

---

## X thread

1. I built tierview: code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when unsure, and prints a cost receipt. It runs on your Claude subscription. No API key. github.com/moelsaka01/tierview
2. Try it free: `npx tierview review --dry-run` shows where every hunk goes and what it would cost, with zero model calls. [demo GIF]
3. The receipt: tokens and cost per tier, plus what the same tokens would cost on the priciest model. On a plan it's API-equivalent, not your bill. [receipt screenshot]
4. Benchmark on 13 real held-out bugs: tierview caught 9, all-Opus 7, all-Sonnet 4. 0 false alarms on 7 clean commits (all-Opus: 3). 16% cheaper per case than all-Opus via Claude Code (7% on direct API pricing).
5. The caveat that matters: n = 13, exact McNemar p = 0.5. Not significant. C-heavy, one run per case, judge audit marked by me. Catches were decided by location rules first and an Opus judge for ambiguous cases. A pilot, not proof. [chart]
6. Not done yet: the GitHub Action's PR comment is untested live; I never ran Fable, so that cost is calculated. Data, limits and a usage-limit bug I hit are all in RESULTS.md. MIT. Tell me where it misses.

---

## LinkedIn

I benchmarked Claude models on 13 real bugs. Here's what I found.

Sending each part of a diff to a model matched to its risk caught 9 of the 13 bugs. Sending everything to the strongest model caught 7, and the cheapest model alone caught 4. The tiered setup also raised no false alarms on 7 clean commits, where the strongest model raised 3, at 16% lower cost per case via Claude Code (7% on direct API pricing).

The caveats matter. With only 13 bugs the difference is not statistically significant (p = 0.5), the set leans toward C, and each case ran once. I marked the judge audit myself; catches were decided by location rules first and an Opus judge for ambiguous cases. Please read it as a pilot. The bugs came from QEMU, DPDK, Django, Cilium and others, where a later commit named the bug.

The tool behind it is tierview, an open-source code reviewer. It scores each hunk with deterministic rules, sends low-risk hunks to a cheaper model and risky ones to a stronger one, escalates when a model is unsure, and prints a cost receipt per tier. It runs on an existing Claude subscription through Claude Code with no API key: `npx tierview review --dry-run` shows the routing and an estimate without making a model call.

The repo has the data, the limits, and a note on a usage-limit bug I found in my own benchmark runner before computing any metric.

Repo: https://github.com/moelsaka01/tierview

---

## dev.to article (draft; not published)

Front matter for dev.to's editor. `published: false` stays until the author publishes by hand. Tags are limited to four. Images: use the raw GitHub URLs of `bench/results/chart.svg` (convert to PNG first if dev.to does not render SVG) and `assets/demo.gif`.

```
---
title: I benchmarked tiered vs all-Opus code review on 13 real bugs. The result is a coin flip I can describe.
published: false
description: 9 vs 7 bugs caught, 0 vs 3 false alarms, 16% cheaper, and why none of it is statistically significant.
tags: ai, opensource, testing, claude
---
```

I built a code reviewer, [tierview](https://github.com/moelsaka01/tierview), that sends each hunk of a diff to the cheapest Claude model that can handle it, and prints a cost receipt. Then I measured it, and the measurement is the interesting part, mostly because of how small it is.

**The setup.** 30 real commits from 9 open-source repos (QEMU, DPDK, Django, Cilium, Tetragon, Firecracker, Next.js and others). 20 introduced a bug that a later commit fixed and named (`Fixes: <sha>`, "regression from #PR"), and `git blame` confirms the fix rewrote lines of the bug commit. 10 are presumed-clean commits from 2025 that no fix touched for 12 months. I split them: 10 for tuning (the dev split), 20 held out (the test split: 13 buggy, 7 clean). I froze the config before the test run and ran each case once per arm.

Three arms, same prompts and output format:
- **tierview:** deterministic risk rules route each hunk; Sonnet 5.5 at low effort for low-risk hunks, one Opus 5.5 high-effort call for risky and escalated hunks.
- **all-Sonnet:** every hunk to Sonnet 5.5 at low effort.
- **all-Opus:** every hunk to Opus 5.5 at medium effort.

A catch means a finding within 3 lines of a line the fix changed (plus a term check on wide fixes), with an Opus judge, blind to the arm, for the cases a rule could not decide.

**The numbers (test split).**

| arm | bugs caught (95% range) | false alarms on 7 clean cases | cost per case via Claude Code |
|---|---|---:|---:|
| tierview | 9 / 13 (46-92%) | 0 | $0.213 |
| all-Opus | 7 / 13 (23-85%) | 3 | $0.254 |
| all-Sonnet | 4 / 13 (8-54%) | 0 | $0.113 |

tierview caught the 7 bugs all-Opus caught plus 2 more; all-Opus caught none that tierview missed. That is 2 discordant cases out of 13. The exact McNemar p-value is **0.5**. The 95% ranges overlap for every pair of arms. This does not show tierview is better. It shows I did not see it be worse, on a sample too small to tell.

**What I trust and what I do not.**

- The dev split disagreed with the test split. On dev, all-Sonnet caught 5 of 7, as many as all-Opus, at the lowest cost. On test it caught 4 of 13, the fewest. If I had stopped at dev I would have written a very different post. Seven bugs did not predict the next thirteen.
- The test set is C-heavy: 7 of the 13 bugs are C from QEMU and DPDK, and TypeScript has one. It says little about other languages.
- Each case ran once. Model answers vary between runs; in the pilot the same input was caught in one run and missed in the next.
- The clean commits are older and calmer than the buggy ones, so the false-alarm numbers may be optimistic. "0 false alarms vs 3" is on 7 clean cases.
- The judge is partly a model, and I audited it myself: of 20 judgements, 14 agree, 0 disagree, 6 unsure. A small sample, marked by the author, with 6 cases unresolved.
- Cost is API-equivalent: the tokens that ran, at list prices. I ran everything on a Claude Pro plan, so I was billed nothing extra. The "all-Fable" line in the receipt is a calculation from tokens, not a run; I never made a Fable call, so I claim nothing about Fable's quality.

**A bug in my own harness.** Test batch 3 hit the plan's 5-hour usage limit mid-run. Claude Code answered with a message my runner did not recognise, so runs whose calls had failed were saved as complete: 10 runs would have counted as reviewed, and the clean ones as "no false alarms". I caught it when I checked the batch, before computing any metric. The runner now treats any failed call as an incomplete run and stops the batch; the 10 runs were redone. If I had not looked at the batch, the false-alarm column would have been flattering for the wrong reason.

**What I would do next.** More bugs, more languages, several runs per case so I can measure variance, and a second person marking the judge audit. Until then, read this as a pilot.

**Try it.** It runs on your Claude subscription through Claude Code, so there is no API key: `npx tierview review --dry-run` shows the routing and an estimate without calling a model. All cases, raw runs and judgements are in the repo under `bench/results/`. I would like to hear where the routing rules are wrong on your code.

---

## awesome-claude-code recommendation (draft; not submitted)

Repo: https://github.com/hesreallyhim/awesome-claude-code. Rules read from its `CONTRIBUTING.md` and issue form on 2026-11-17.

**Rules that matter here:**
- **Eligibility:** the resource must either be at least 14 days old (since the first commit on the default branch) with ongoing commits, or have 100 stars. tierview's first commit is 2026-11-16, so it becomes eligible on **2026-11-30**, provided there are commits between now and then. It has 0 stars today. Do not submit earlier: the form's bot closes ineligible submissions.
- **A human must submit it.** Recommendations must be written by a person through the web issue form (not a PR, and not possible with the `gh` CLI), or the submitter risks a temporary restriction. So this is a draft for the author to paste, not something to automate.
- **One resource at a time.** No other submission may be open.
- **Style:** a description, not a sales pitch; no addressing the reader; one line; no emojis; 10-500 characters.
- **Checklist in the form:** the author must have looked at the list and confirmed the resource is distinct from existing entries (search the list for code-review and cost-tracking entries before submitting), links work, it is specific to Claude Code, CONTRIBUTING.md was read. Leave the last optional box unchecked, as the form says.
- The maintainer says there is no guarantee of a response and that the list is selective. Having real users first helps more than the submission does.

**Form fields** (issue form: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml):

- **Display Name:** `tierview`
- **Category:** `Observability & Monitoring > Usage & Cost` (the receipt is the distinguishing feature). Alternative if that reads as a stretch after looking at the list: `Open Source Contribution & Maintenance`. The author should pick after reading the category sections.
- **Link:** `https://github.com/moelsaka01/tierview`
- **Author Name:** `moelsaka01`
- **Author Link:** `https://github.com/moelsaka01`
- **Description** (one line, 10-500 characters):

  > CLI that reviews a git diff by scoring each hunk with deterministic risk rules and routing it to Sonnet or Opus through the official `claude -p` CLI, so it runs on an existing Claude plan with no API key. It escalates when a model is unsure and prints a cost receipt per tier. Includes a small published benchmark on 13 held-out real bugs (9 caught vs 7 for all-Opus; not statistically significant).

- **Checklist:** the author ticks the required boxes only after doing what they say.

**Fit to check first:** the form asks for a resource "specific to Claude Code". tierview's default backend runs Claude Code, but it also has an API-key backend and a GitHub Action that do not. The description above leads with the Claude Code path; do not claim more.
