# Scheduled task: Tour Core (ChatGPT)

ChatGPT runs a scheduled task at most once an hour, and nothing outside
ChatGPT can start one. So Tour Core can't wake ChatGPT when a visitor asks for
a tour time. Each run reads what's new with `get_updates` instead.

## Make it

1. In the setup chat, with Property Core attached, ChatGPT creates a scheduled
   task named **Tour Core** that runs every hour, a few minutes past the hour,
   with the prompt below word for word, and keeps **Property Core** attached.
2. ChatGPT calls save_alert_routine with no arguments to connect it. There
   is no Fire URL, token, or page: nothing secret is saved. Connecting it is
   the whole step, since nothing can send it a test.

If ChatGPT can't create the task from the chat, the host makes it on ChatGPT's
scheduled tasks page with the same name, schedule, and prompt.

## Texts to the host's phone

Right after, ChatGPT asks "Want tour updates texted to your phone too?" with
three choices: Urgent only, Everything, No texts, and says that ChatGPT checks
for updates at most once an hour, so a text gets there sooner. Urgent only is
the usual pick: a visitor asking for a time, or a problem. If the host wants
texts, ChatGPT asks for their phone and calls `save_host_texts`. A text never
names a visitor.

## If it stops

A ChatGPT task can be paused. Once a property is published, `get_state` warns
when no check has come in for over two and a half hours, and ChatGPT tells the
host to turn the task back on.

## Prompt

```text
Check Tour Core for new tour updates. Call get_updates.
If it returns nothing, stop and say nothing.
For a visitor asking for a tour time, or anything that needs me, call get_inbox and tell me what it is and what I can do, in a few short words.
Sum up any tours booked, started, finished, or cancelled in one line.
Never text anyone yourself, and never change anything without my yes.
```
