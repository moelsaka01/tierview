# Launch posts

Drafts for the v0.1.0 launch (numbers rewritten on 2026-11-20 after the second held-out set reversed the first result). Nothing here is posted until the author says yes to each post's final text. All posting is done manually by the author. Repo: https://github.com/moelsaka01/tierview

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

All posts: give both results (first set 9 vs 7, second set 3 vs 9, pooled 12 vs 16 of 23, p = 0.29), say that single runs and an author-marked judge limit them; lead with the free path and the receipt; no "Fable-level" claim (Fable was never measured).

---

## Show HN (postponed: new accounts cannot post Show HN)

Kept for later; not part of the Friday posts. Re-check the numbers against `bench/results/RESULTS.md` on the day.

**Title:** `Show HN: Tierview – Claude code review that routes each hunk to a cheaper model`

**URL:** https://github.com/moelsaka01/tierview

**First comment (post it right after submitting):**

> I built tierview because I wanted code review on diffs without sending everything to the most expensive model. It scores each hunk of a diff with deterministic rules (auth, SQL, memory, boundary changes, timeouts...), sends boring hunks to Sonnet at low effort and risky ones to Opus, escalates when a model is unsure or contradicts itself, and prints a cost receipt: tokens and cost per tier, plus what the same work would cost on the most expensive model.
>
> It runs on your existing Claude subscription through the official Claude Code CLI (`claude -p`), so there is no API key on the default path: `npx tierview review --dry-run` shows the routing and an estimate with zero model calls, and `npx tierview review` runs it. There is also an API-key backend and a GitHub Action.
>
> The benchmark result is mixed, and I would rather lead with that. I ran it on real bugs, where a later commit named the cause. On the first 13 held-out bugs (mostly C) it caught 9 vs 7 for all-Opus. I then added 10 more held-out bugs (mostly Python, Rust, Go) under the same frozen config, and it caught 3 vs 9. Pooled, 23 bugs: tierview 12, all-Opus 16, all-Sonnet 10; no false alarms on 12 clean commits for tierview (all-Opus raised one on 3 of them); 18% cheaper per case than all-Opus, but more expensive per bug caught. The pooled gap is not significant (exact McNemar p = 0.29). My reading, untested: the risk rules were tuned on C-heavy data and mostly sent the new logic bugs to the cheap reviewer. Single runs, I marked the judge audit myself, and the second set is smaller than I planned. Everything is in bench/results/RESULTS.md.
>
> Not done: the GitHub Action's PR comment has only been tested against mocked responses; the API backend is unit-tested only; I never ran Fable, so its cost line is a calculation. Tiered routing is not new (d1ff and others do it); I did not find a published benchmark or a receipt like this. I would like to hear where the routing rules are wrong on your code.

---

## r/ClaudeAI

Check the sidebar rules and flair before posting.

**Title:** `I built a code reviewer that runs on your Claude subscription (no API key) and prints a cost receipt. My benchmark result flipped when I added more bugs.`

> tierview reviews a git diff by sending each hunk to the cheapest Claude model that can handle it: Sonnet 5.5 at low effort for boring hunks, Opus 5.5 for risky ones, with escalation when a model is unsure. It runs through Claude Code (`claude -p`), so it uses the plan you already have. No API key.
>
> ```
> npx tierview review --dry-run   # zero model calls: routing + estimated cost
> npx tierview review             # the real review
> ```
>
> After each run it prints a receipt: tokens and API-equivalent cost per tier, and what the same tokens would cost on Fable (a calculation, not a run). Fable is opt-in, because on some plans `claude -p` bills it as extra usage without asking.
>
> The honest benchmark story: on my first 13 held-out real bugs it caught 9 vs 7 for all-Opus. I then added 10 more (mostly Python, Rust, Go) and it caught 3 vs 9. Pooled (23 bugs): tierview 12, all-Opus 16, all-Sonnet 10; zero false alarms for tierview on 12 clean commits (all-Opus: 3); 18% cheaper per case than all-Opus but not per bug caught. The pooled gap is not significant (p = 0.29), single runs, judge audit marked by me. My guess is that my risk rules, tuned on C, send logic bugs in other languages to the cheap reviewer, but I have not tested that.
>
> The benchmark used about 255 calls on a Pro plan and hit the 5-hour limit once, so mind your limits (`--max-calls` helps). Repo, data and every caveat: https://github.com/moelsaka01/tierview. Built with Claude Code across several sessions; the build log is in the repo. Where would you expect it to miss?

---

## X thread

1. I built tierview: code review that sends each hunk of a diff to the cheapest Claude model that can handle it, escalates when unsure, and prints a cost receipt. It runs on your Claude subscription. No API key. github.com/moelsaka01/tierview
2. Try it free: `npx tierview review --dry-run` shows where every hunk goes and what it would cost, with zero model calls. [demo GIF]
3. The receipt: tokens and cost per tier, plus what the same tokens would cost on the priciest model. On a plan it's API-equivalent, not your bill. [receipt screenshot]
4. The benchmark, honestly: on my first 13 held-out real bugs it caught 9 vs 7 for all-Opus. I added 10 more, mostly Python/Rust/Go, same frozen config: 3 vs 9.
5. Pooled, 23 bugs: tierview 12, all-Opus 16, all-Sonnet 10. No false alarms on 12 clean commits (all-Opus: 3). 18% cheaper per case than all-Opus, but not per bug caught. Not significant (p = 0.29). [chart]
6. My guess, untested: my risk rules were tuned on C and mostly sent the new logic bugs to the cheap reviewer. Single runs, judge audit marked by me, second set smaller than planned.
7. Also not done: the Action's PR comment is untested live; I never ran Fable. Data and limits are in RESULTS.md. MIT. Tell me where it misses.

---

## LinkedIn

I benchmarked my own tool on real bugs, and the result changed when I added more bugs. Here it is, as it stands.

tierview is an open-source code reviewer for Claude. It scores each part of a diff with deterministic rules, sends low-risk parts to a cheaper model and risky ones to a stronger one, and prints a cost receipt. It runs on an existing Claude subscription through Claude Code with no API key: `npx tierview review --dry-run` shows the routing and an estimate without making a model call.

On my first 13 held-out bugs (mostly C) it caught 9, against 7 for sending everything to the strongest model. I then added 10 more (mostly Python, Rust and Go) under the same frozen settings, and it caught 3, against 9. Pooled across all 23: tierview 12, strongest model 16, cheapest model 10. tierview raised no false alarms on 12 clean commits (the strongest model raised one on 3 of them) and was 18% cheaper per case, but not cheaper per bug caught. The pooled gap is not statistically significant (p = 0.29), each case ran once, and I marked the judge audit myself, so read it as a pilot. My guess is that the risk rules, tuned on C, rated the new bugs as boring, but I have not tested that.

I would rather publish the mixed result than the flattering half of it. The repo has the data, the limits, and a note on a usage-limit bug I found in my own benchmark runner before computing any metric.

Repo: https://github.com/moelsaka01/tierview

---

## dev.to article (draft; not published)

Front matter for dev.to's editor. `published: false` stays until the author publishes by hand. Tags are limited to four. Images: use the raw GitHub URLs of `bench/results/chart-heldout.svg` (convert to PNG first if dev.to does not render SVG) and `assets/demo.gif`.

```
---
title: My benchmark said my tool beat all-Opus. Ten more bugs said otherwise.
published: false
description: 9 vs 7 on the first 13 bugs, 3 vs 9 on the next 10, 12 vs 16 pooled, and why none of it is conclusive.
tags: ai, opensource, testing, claude
---
```

I built a code reviewer, [tierview](https://github.com/moelsaka01/tierview), that sends each hunk of a diff to the cheapest Claude model that can handle it, and prints a cost receipt. Then I measured it twice. The second measurement disagreed with the first, and the disagreement is the interesting part.

**The setup.** Real commits from open-source repos where a later commit fixed a bug and named its cause (`Fixes: <sha>`, "regression from #PR"), and `git blame` confirms the fix rewrote lines of the bug commit. Clean cases are 2025 commits that no fix touched for 12 months. Each case runs once per arm, with the config frozen first. Three arms with the same prompts and output format:
- **tierview:** deterministic risk rules route each hunk; Sonnet 5.5 at low effort for low-risk hunks, Opus 5.5 at high effort for risky and escalated ones.
- **all-Sonnet:** every hunk to Sonnet 5.5 at low effort.
- **all-Opus:** every hunk to Opus 5.5 at medium effort.

A catch means a finding within 3 lines of a line the fix changed (plus a term check on wide fixes), with an Opus judge, blind to the arm, for cases a rule could not decide.

**First set: 13 bugs, mostly C (QEMU, DPDK, Django, Cilium, Firecracker, Next.js).** tierview 9, all-Opus 7, all-Sonnet 4. False alarms on 7 clean cases: tierview 0, all-Opus 3. tierview was 16% cheaper per case. McNemar p = 0.5.

**Second set: 10 bugs, mostly Python, Rust and Go (Django, Bevy, pytest, Tetragon, DPDK), added afterwards, same frozen config.** tierview 3, all-Opus 9, all-Sonnet 6. McNemar p = 0.03, though that is a post-hoc look at one subset.

**Pooled, 23 bugs and 12 clean cases.**

| arm | bugs caught (95% range) | clean cases with a false alarm | cost per case via Claude Code |
|---|---|---:|---:|
| tierview | 12 / 23 (30-74%) | 0 / 12 | $0.229 |
| all-Opus | 16 / 23 (48-87%) | 3 / 12 | $0.278 |
| all-Sonnet | 10 / 23 (22-65%) | 1 / 12 | $0.127 |

tierview caught 2 bugs all-Opus missed; all-Opus caught 6 that tierview missed. Exact McNemar p = 0.29. tierview was 18% cheaper per case than all-Opus but cost more per bug caught ($0.514 vs $0.455), because it caught fewer.

**What I think happened, and what I have not shown.** The routing rules were tuned on a C-heavy dev split. On the new cases they scored most hunks 0 to 5 and sent the faulty hunk to the cheap reviewer in 7 of 10 cases; in the four it missed among those, the cheap reviewer reported nothing at all. The baselines send every hunk through the deeper prompt, and all-Sonnet caught three bugs tierview missed. That points at the router and the cheap prompt, not the model. It is a reading of the logs. I did not re-run or re-tune anything, and in three other cases tierview did route the hunk to Opus and still missed it, which single runs cannot separate from variance.

**What I trust and what I do not.**
- Neither set is large. The 95% ranges overlap everywhere. Pooling the two is a convenience, not a pre-registered analysis, and I chose the second set after seeing the first.
- The second set is smaller than I planned (10 buggy cases, not 20), its fixes reach back to March 2026 (two predate mid-2026, so training-data contamination is possible), and Django and DPDK are over my 20% per-repo cap.
- The judge is partly a model. I hand-checked 20 judgements from the first set (14 agree, 0 disagree, 6 unsure); the second set's are not audited. I wrote the one-line bug descriptions the judge uses.
- Cost is API-equivalent (tokens at list prices); I ran everything on a Pro plan and was billed nothing extra. The "all-Fable" line in the receipt is a calculation, not a run.

**A bug in my own harness.** One batch hit the plan's 5-hour usage limit mid-run. Claude Code answered with a message my runner did not recognise, so runs whose calls had failed were saved as complete: 10 runs would have counted as reviewed, and the clean ones as "no false alarms". I caught it before computing any metric. The runner now treats any failed call as an incomplete run and stops the batch.

**What I would do next.** Test whether the router is the problem (re-route on a held-back split and compare), add signals for the bug classes it missed, run each case several times, and have a second person mark the judge audit. Until then, read the first result as luck or as a C-specific effect, and the second as a warning.

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

  > CLI that reviews a git diff by scoring each hunk with deterministic risk rules and routing it to Sonnet or Opus through the official `claude -p` CLI, so it runs on an existing Claude plan with no API key. It escalates when a model is unsure and prints a cost receipt per tier. Includes a small published benchmark on 23 held-out real bugs (12 caught vs 16 for all-Opus; not statistically significant).

- **Checklist:** the author ticks the required boxes only after doing what they say.

**Fit to check first:** the form asks for a resource "specific to Claude Code". tierview's default backend runs Claude Code, but it also has an API-key backend and a GitHub Action that do not. The description above leads with the Claude Code path; do not claim more.
