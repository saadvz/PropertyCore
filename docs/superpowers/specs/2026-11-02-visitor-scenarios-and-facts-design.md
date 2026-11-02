# Visitor scenarios and the property facts sheet

Date: 2026-11-02. Status: approved in chat, awaiting review of this spec.

## Goal

A visitor texting a touring number gets an answer from the service for
everything it can know. That covers tour logistics (open times, rescheduling,
their booking, cancelling, directions, entry) and any property fact the
landlord gave it. The landlord is contacted only for what the service can't
answer.

Setup also asks the landlord for the extra property facts that visitors ask
about.

## What a live test showed

On a booked visitor's thread:

- "Can I change the time for the tour?" went to the landlord as a property
  question. There is no reschedule intent, and the custom-time rule needs a
  time in the text.
- "Ok what times are available?" was answered "1312 S Moody Avenue is
  available now". That is the unit's move-in availability, not the open tour
  slots.

## Decisions

- **Approach A: a scenario catalog that runs as tests.** Every entry runs
  through the real text path, today's failures are fixed, and the catalog
  guards against regressions.
- **Rules plus a language model.** The keyword rules run first. Tour Core's
  existing model layer handles only the texts the rules can't place. The model
  is Gemini, through its OpenAI-style endpoint; the version is the Railway
  setting, never written into code.
- **The facts sheet is a short checklist plus free text.** Each question can
  be skipped, and the landlord can add to it anytime.

## 1. The scenario catalog

`test/visitorScenarios.test.ts` holds one entry per visitor text, at a given
point in the flow, with the expected handling. Each entry runs on a 555
Scratch tenant through the shared service's real text path, then checks
touring's reply, and whether anything went to the landlord.

| # | Point | Texts | Expected handling |
| --- | --- | --- | --- |
| 1 | Before booking | "Hi, I'd like to tour", "Is this still available?" | Starts booking |
| 2 | Before booking | "What times do you have?", "Any openings Saturday?" | Lists open slots, for that day if one was named |
| 3 | Before booking | "Can I come at 6:30 tomorrow?" | Books it if open; otherwise a time request to the landlord |
| 4 | Before booking | "How much is rent?", "How many bedrooms?", "Pets?", "Parking?" | Answered from setup details |
| 5 | Before booking | "How do I apply?", "What's the deposit?", "How long is the lease?" | Answered from the facts sheet |
| 6 | Any time | "Where is it?", "What's the address?" | The address and a map link |
| 7 | Any time | "Is it furnished?", "Is the dishwasher new?" | Answered from facts if covered; otherwise the landlord |
| 8 | Booked | "When is my tour?", "What time is my tour again?" | Day, time, door window, and address |
| 9 | Booked | "Can I change the time?", "Can we do Thursday instead?" | Reschedule (section 2) |
| 10 | Booked | "Cancel my tour" | Confirms, then cancels |
| 11 | Booked | "Can I bring someone?", "How long does the tour take?", "Do I need ID?" | From tour settings or facts |
| 12 | Day of | "I'm running late", "On my way" | Acknowledged, with the door window |
| 13 | On tour | "I'm here", "The door won't open", "I'm lost", "Which unit?" | The existing arrival and help flow |
| 14 | On tour | "Can I have more time?" | The existing more-time flow |
| 15 | On tour | "Done", "I'm finished" | The existing finish flow |
| 16 | After | "How do I apply?", "When can I move in?" | From facts |

The catalog also covers these, as they work today:

- STOP, START and HELP;
- injury and emergency texts;
- fair-housing questions (always sent to the landlord, never answered);
- texts that try to instruct the assistant.

**The rule the catalog pins.** A text reaches the landlord only in these
cases:

- a property question that setup details, the facts sheet, and earlier
  approved answers can't answer;
- a fair-housing question;
- a time request outside the open slots.

Logistics never reach the landlord.

New entries are added as the audit finds gaps.

## 2. New visitor handling and the language model

### New intents

- **`ASK_OPEN_TIMES`** (optional day): lists the next open slots, or that
  day's. It sends no time request to the landlord.
- **`RESCHEDULE_TOUR`** (optional day and time), for a visitor with a booking:
  - With no time, it offers open slots. Picking one moves the booking.
  - With a time that's open, it moves the booking: the new slot is confirmed,
    then the old one is released, and the door window moves with it.
  - With a time that isn't open, it sends a time request to the landlord as
    today. The old booking stays until they decide.
- **`ASK_MY_TOUR`**: repeats the day, time, door window, and address.
- **`ASK_DIRECTIONS`**: the address and a map link, before or after booking.

### Tour logistics answered from settings

- **Tour length:** from the tour length set at setup.
- **ID:** from the identity step.
- **Bringing someone:** from the facts-sheet item (section 3).

### The language model

- The rules run first. Only texts they can't place confidently go to the
  model (the existing `LayeredIntentInterpreter`).
- **Picking an intent.** The model gets the text and the list of intents,
  including the new ones. It returns one intent, or `UNKNOWN`, as JSON. It
  never writes a reply.
- **Picking a fact.** For a property question that keyword matching can't
  answer, the model gets the question and the property's approved facts,
  numbered. It returns one number or "none".
  - The visitor gets that fact word for word.
  - A number that doesn't exist counts as "none".
  - "None" sends the question to the landlord as today.
- **Privacy.** The model never sees a visitor's name or phone number;
  touring strips them first.
- **Failure.** If the model is slow, down, or returns something invalid, the
  rules' answer stands. The timeout is `TOURCORE_INTENT_MODEL_TIMEOUT_MS`,
  with the existing default.

### Configuration

- `TOURCORE_INTENT_MODEL_URL`, `TOURCORE_INTENT_MODEL_KEY`, and
  `TOURCORE_INTENT_MODEL` turn the model on.
  - The URL is Gemini's OpenAI-style endpoint:
    `https://generativelanguage.googleapis.com/v1beta/openai`.
  - The model is whatever Gemini Flash or Flash-Lite version the landlord's
    operator sets.
- `buildTouringEnv` passes these three, plus the timeout, into each touring
  process. Today it strips every `TOURCORE_*` variable.
- The key lives only in Railway. It never appears in a log, a reply, a chat,
  or the repo.
- Without the variables, everything still works on the rules alone.

## 3. The facts sheet

### A new setup step: "Property facts"

It comes after hours and before tour updates. It asks one question at a time,
and each can be skipped:

1. How do people apply?
2. Is there an application fee or deposit?
3. What lease lengths do you offer?
4. What's due at move-in?
5. Can visitors bring someone on the tour?
6. Any building rules visitors should know?
7. Anything about the area worth mentioning?
8. Anything else visitors should know? (free text, split into one fact per
   sentence or line)

### Storage and use

- Each answer is stored word for word as an approved fact on the property,
  prefixed with its topic, for example `How to apply: Apply online at …`.
  This is the property's existing `facts` list.
- Visitor questions match them by keyword first, then by the model.
- A skipped topic stays empty. A question about it goes to the landlord, and
  their approved answer is saved for next time, as today.

### Managing facts

- **`save_facts`**: a new landlord tool.
  - Input: `property`, `topic` (`apply`, `fees`, `lease`, `move_in`,
    `guests`, `rules`, `area`, `other`), and `text`. `skip: true` records a
    skipped topic. `remove: true` deletes that topic's fact.
  - Setup's step calls it, and the landlord can call it anytime.
- **`get_state`**: the property summary lists the facts.

### Fair housing

- A fact stating a preference about who may live there is refused, never
  stored or sent, with a plain explanation. Examples: family status, age,
  religion, national origin, disability, sex, race, or similar wording like
  "no kids" or "ideal for a young professional". This uses the existing
  fair-housing checks, extended to statements.

### Existing properties

- A published property without facts keeps working.
- `get_state` offers the facts step as an optional action, without blocking.

## 4. Errors, testing, and rollout

### Errors

- **An intent that doesn't fit the step** (for example, reschedule with no
  booking): caught by the existing step checks. Touring asks a short
  clarifying question, and nothing reaches the landlord.
- **Two visitors taking the same slot:** the existing slot locking applies.
  The loser is offered the next open times, and their old booking stays.
- **A failed reschedule:** the old booking stays until the new one is
  confirmed. A visitor is never left with neither.

### Testing

- **CI:**
  - The scenario catalog runs in CI on a 555 Scratch tenant, with the model
    replaced by a recorded fake. CI needs no key and makes no API calls.
  - Unit tests cover:
    - the new intents' rules;
    - reschedule, including the failure cases above;
    - picking a fact, including invalid and "none" picks;
    - the facts step and `save_facts`, including fair-housing refusals;
    - the environment pass-through.
- **The model check:** `npm run eval:visitor-model` runs the catalog against
  the configured real model and reports each entry. It's run locally, and not
  in CI.
- **The full check:** `scripts/ci-check.sh` passes.

### Rollout

- It lands on `claude/tender-bardeen-oid5hr`, in the same pull request.
- The model stays off until the Railway variables are set.
- The touring setup skill and the Property Core guides get the facts step.
- Live texts follow the existing live-texting switch and allowlist.
