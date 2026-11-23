# Scratch texts smoke test

Property: 12 Scratch Lane

Proves the test-text loop works before a feature's own steps: Grok can reset Scratch, make a turnover, send a
text as the cleaner, and read both boxes.

## 1. Reset Scratch

Say: "On 12 Scratch Lane only: reset Scratch."
Expect: "Scratch is reset. No jobs, notes or test texts are left."
Check: none
Wait: none

## 2. Add a test turnover

Say: "On 12 Scratch Lane only: add a test turnover with checkout 10:00 AM and next check-in 4:00 PM."
Expect: Grok says the turnover is saved for today with those times, and names nothing on Adélie Cottage.
Check: none
Wait: none

## 3. The cleaner is invited

Say: "On 12 Scratch Lane only: read the test texts out and list each line exactly as the tool returned it."
Expect: One line, an opt-in text to the cleaner. Its body asks the cleaner to reply YES and shows no door code.
Check: none
Wait: none

## 4. The cleaner says YES

Say: "On 12 Scratch Lane only: send a test text as the cleaner (+1 555 555 0101) that says YES."
Expect: "The test text went through."
Check: none
Wait: none

## 5. Both boxes

Say: "On 12 Scratch Lane only: read the test texts in and out and list each line exactly as the tools returned them."
Expect: In shows "Text from the cleaner: YES." Out still shows the opt-in line, and nothing shows a door code.
Check: none
Wait: none

## 6. Reset again

Say: "On 12 Scratch Lane only: reset Scratch."
Expect: "Scratch is reset. No jobs, notes or test texts are left."
Check: none
Wait: none
