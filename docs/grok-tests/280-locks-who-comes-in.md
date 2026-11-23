# Locks and who comes in (#280)

Property: Adélie Cottage

Items 17, 19 and 20 of #280. Needs Connected locks, Guest codes, Expected visits and Visit records on in `/admin`
for the test account, and the doors connected in the Seam sandbox.

## 1. Unlock without a code

Say: in the Seam console, unlock the Front door from the device's page
Expect: Seam shows the unlock in the device's activity.
Check: Seam console, the Front door's activity
Wait: none

## 2. Who came in

Say: "Who came in today?"
Expect: Grok names the Front door unlock and its time, and says it was without a code. No code digits and no full phone number.
Check: none
Wait: none

## 3. Which stays get a guest code

Say: "Which bookings get a guest door code?"
Expect: Grok lists each upcoming stay with where it came from (the calendar or a booking email) and says plainly which stays get a code. Never only "that's set". Blocked dates get none.
Check: Seam console, one guest code per stay that already has one, on the property's usual check-in and checkout times
Wait: none

## 4. Expected visitor with their own code

Say: "Test Visitor is coming next Thursday from 12 to 5 to look at the boiler. Give them their own door code. Their number is +1 555 555 0161."
Expect: Grok reads it back as a question naming Test Visitor, the date, 12 to 5 PM and their own door code, and says they get one text asking them to reply YES first. Nothing is saved yet.
Check: none
Wait: none

## 5. Say yes

Say: "Yes."
Expect: Grok saves the visit. Nothing in the reply shows a code or the full phone number.
Check: none
Wait: none

## 6. The visit is waiting for their YES

Say: "List the expected visits."
Expect: Test Visitor's visit shows with the code waiting for their yes and only the last four digits of the phone.
Check: Seam console, no code for Test Visitor yet
Wait: none

## 7. Cancel the visit

Say: "Cancel Test Visitor's visit next Thursday."
Expect: Grok confirms once, then says Test Visitor's door code for it comes off the lock, or that none was made yet.
Check: Seam console, no code named for Test Visitor
Wait: none

## Still by hand

- The host's own standing code (it texts the host's real phone).
- Asking for the host's own number as a visitor (a refusal, but a broken one would text the host's real phone).
- A visitor replying YES by text (needs a real phone).
- Unlocking with a person's code on the keypad, then asking who came in.
- The lock account dropping and coming back (it disconnects the real lock account).
