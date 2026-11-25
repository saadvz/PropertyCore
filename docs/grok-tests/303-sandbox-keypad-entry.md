# A real keypad entry on the sandbox lock (#303)

Property: Adélie Cottage

Checks #180, #237 and #240 with a real entry: the code is typed on the sandbox lock's keypad by
`npm run locks:sandbox-entry`, run in a shell on the service (where the data volume and the sandbox key are), so
the unlock comes back through the webhook like one from the door. Needs Connected locks, Visit records and Expected
visits on in `/admin` for the test account. Before step 1, the property needs: a cleaning today whose code is on the
Front door, a routine vendor's confirmed visit with its code made, an expected visitor today with their own code,
the host's standing code, and a guest stay with its code. The command never prints a code: it names whose code it
was, the door and the time. If a person has more than one code, it lists them and asks for `--pick`.

## 1. The cleaner's code on the keypad

Say: in the service's shell, run npm run locks:sandbox-entry -- --property "Adélie Cottage" --who cleaner
Expect: The command says it entered the cleaner's code on the Front door keypad, and the time. No digits.
Check: Seam console, the Front door's activity shows one keypad unlock with the code named Cleaning
Wait: 1 minute

## 2. Who came in

Say: "Who came in today?"
Expect: Grok names the cleaner's entry on the Front door at that time, once (not twice), with the code's owner named. No code digits and no full phone number.
Check: none
Wait: none

## 3. The cleaner's arrival

Say: "Has the cleaner arrived?"
Expect: Grok says the cleaner arrived at the time of step 1, from the lock.
Check: none
Wait: none

## 4. The vendor's code inside their window

Say: in the service's shell, run npm run locks:sandbox-entry -- --property "Adélie Cottage" --who vendor
Expect: The command says it entered the vendor's code and the time, and doesn't say it was outside its window. If it was, run this step again inside the window.
Check: Seam console, the Front door's activity shows one keypad unlock with the code named Repair
Wait: 1 minute

## 5. The vendor's visit record

Say: "How long has the vendor been at the house?"
Expect: Grok gives the vendor's arrival from step 4 and the time on site so far.
Check: none
Wait: none

## 6. The expected visitor's code

Say: in the service's shell, run npm run locks:sandbox-entry -- --property "Adélie Cottage" --who visitor
Expect: The command says it entered the visitor's code and the time.
Check: Seam console, the Front door's activity shows one keypad unlock with the code named Visit
Wait: 1 minute

## 7. The same-day check clears

Say: "Did the expected visitor come in today?"
Expect: Grok says the visitor came in at the time of step 6, and no "nobody came in" flag is due for that visit.
Check: none
Wait: none

## 8. The host's and a guest's codes don't count

Say: in the service's shell, run the command with --who host, then with --who guest, on a day with an expected visit nobody has come in for
Expect: The command enters each code. Neither clears that visit's "nobody came in" flag.
Check: Seam console, two keypad unlocks, named Standing and Guest
Wait: 1 minute

## 9. Still flagged

Say: "Did the expected visitor come in today?"
Expect: Grok names the host's and the guest's entries but says the expected visitor hasn't come in. The flag still goes out after the window.
Check: none
Wait: none

## 10. A code outside its window

Say: in the service's shell, run the command for a code whose window isn't open, with --pick if the list asks
Expect: The command says it was outside the window. Write down what the lock does with it.
Check: Seam console, the Front door's activity: whether the lock opened or refused it
Wait: 1 minute

## 11. What the visit log says

Say: "Who came in today?"
Expect: Write down whether the entry from step 10 shows, and under whose name. No code digits.
Check: none
Wait: none

## Still by hand

- The cleaner's DONE text after step 3, which gives the cleaning's time on site (#237). A 555 number can't text the
  line, so send it from the test cleaner's phone or the scratch path.
- Posting the results on #180, #237 and #240.
