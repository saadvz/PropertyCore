# Recurring task: Tour Core (Muse)

Nothing outside Muse can start a Muse task, so Tour Core can't wake Muse when
a visitor asks for a tour time. The task runs as often as the host sets it,
and each run reads what's new with `get_updates`.

## Make it

1. In the setup chat, Muse creates a recurring task named **Tour Core** with
   the prompt below word for word, and the **Property Core** connector
   attached. Ask the host how often it should run. Every 15 minutes is a good
   start.
2. Muse calls save_alert_routine with no arguments to connect it. There is no
   Fire URL, token, or page: nothing secret is saved. Connecting it is the
   whole step, since nothing can send it a test.

## Texts to the host's phone

Right after, Muse asks "Want tour updates texted to your phone too?" as a
choice card with Urgent only, Everything, and No texts, and says that Muse
checks for updates as often as its task runs, so a text gets there sooner.
Urgent only is the usual pick: a visitor asking for a time, or a problem. If
the host wants texts, Muse asks for their phone and calls `save_host_texts`. A
text never names a visitor.

## If it stops

Once a property is published, `get_state` warns when no check has come in for
over two and a half hours, and Muse tells the host to turn the task back on.

## Prompt

```text
Check Tour Core for new tour updates. Call get_updates.
If it returns nothing, stop and say nothing.
For a visitor asking for a tour time, or anything that needs me, call get_inbox and tell me what it is and what I can do, in a few short words.
Sum up any tours booked, started, finished, or cancelled in one line.
Never text anyone yourself, and never change anything without my yes.
```
