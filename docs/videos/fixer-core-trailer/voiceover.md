# Fixer Core trailer: voiceover script

90 seconds, about 200 words. Each line is timed to its scene, so a calm, unhurried read fits. Start each line on its timecode, and let the gaps breathe.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 – 0:07 | The Lake House. The cleaner says the AC is blowing warm; a guest asks if it's cool inside. | The AC's blowing warm, and guests land at four. Something always breaks right before check-in. |
| 0:07 – 0:15 | The problem, three lines. | You call five pros, and three don't pick up. The one who calls back gets your cell. And the quotes end up everywhere. |
| 0:15 – 0:19 | Title: Fixer Core. | Meet Fixer Core. Your rental, kept fixed. |
| 0:19 – 0:37 | Setup in a Grok chat: trades, pros, alerts, upkeep, Activate. | Set it up in one chat with Grok. Tell it who you already call. Turn on alerts, so you hear the moment a pro gets back to you. Add regular upkeep, like filters every ninety days. Then switch it on. |
| 0:37 – 0:46 | The host reports the AC. Grok shows three pros nearby. | When something breaks, just say so. Grok finds licensed pros nearby, and you pick who to call. |
| 0:46 – 0:54 | Grok calls all three. Two quote; one will call back. | Grok makes the calls and gets a quote from each. One pro needs to call back, so Grok gives them your Fixer Core line. |
| 0:54 – 1:07 | Only with Fixer Core: the pro's voicemail and text land in the chat. | The pro calls back, and it never reaches your cell. Their voicemail turns into text, right in your chat, and their texts land there too. Grok makes the call. Fixer Core catches the reply. |
| 1:07 – 1:17 | Three quotes side by side. Book it. Code sent, fixed, cost logged. | Every quote, side by side. Nothing's booked until you say yes. Then the door code goes to that pro alone, and the cost is logged. |
| 1:17 – 1:24 | Safe by design. | Only pros you approve. Never over a guest stay. And it never pays anyone. |
| 1:24 – 1:30 | End card. | Fixer Core. Repairs and upkeep, handled for you. |

## The read, start to finish

The AC's blowing warm, and guests land at four. Something always breaks right before check-in.

You call five pros, and three don't pick up. The one who calls back gets your cell. And the quotes end up everywhere.

Meet Fixer Core. Your rental, kept fixed.

Set it up in one chat with Grok. Tell it who you already call. Turn on alerts, so you hear the moment a pro gets back to you. Add regular upkeep, like filters every ninety days. Then switch it on.

When something breaks, just say so. Grok finds licensed pros nearby, and you pick who to call.

Grok makes the calls and gets a quote from each. One pro needs to call back, so Grok gives them your Fixer Core line.

The pro calls back, and it never reaches your cell. Their voicemail turns into text, right in your chat, and their texts land there too. Grok makes the call. Fixer Core catches the reply.

Every quote, side by side. Nothing's booked until you say yes. Then the door code goes to that pro alone, and the cost is logged.

Only pros you approve. Never over a guest stay. And it never pays anyone.

Fixer Core. Repairs and upkeep, handled for you.

## The recording

The ten recorded lines are in `voiceover/`, `01.mp3` to `10.mp3` in script order. `voiceover.json` says where each one plays. Line 4 is cut at its sentence pauses so each sentence lands on its step of the setup chat. To swap in a new take, replace its file. If its length changes, nudge `at` in `voiceover.json`. Then render:

```bash
node docs/videos/fixer-core-trailer/render.mjs video fixer-core-trailer.mp4 docs/videos/fixer-core-trailer/voiceover.json
```

To hear the mix alone: `node docs/videos/fixer-core-trailer/render.mjs audio mix.wav docs/videos/fixer-core-trailer/voiceover.json`.
