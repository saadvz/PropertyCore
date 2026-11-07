# Outdoor code: rotate and offboard

Cleaner Core does not change the lock. The host does that on the lock, then saves the new code through a one-time upload link from their Cleaner Core chat (`save_door_code` with no `code`, as in step 6 of [CLEANER_CORE_BOOTSTRAP.md](../CLEANER_CORE_BOOTSTRAP.md)). The code never goes in a text. The store keeps a sealed reference. The code is sent only to that property's opted-in approved cleaner, and only after the host says the guests have left.

The host-facing text, also returned by `npm run cleaner:health`, is:

> To change the outdoor code at {address}, set the new code on the lock yourself, then save it in your Cleaner Core chat, which gives you a one-time secure link for it. Never text me the code. I store only a sealed reference. I do not change the lock. To offboard a cleaner, reply STOP from their number or tell me to remove them. I will not send the code again until you confirm a new cleaner and the guests have left.

Steps for the host:

1. Set the new code on the lock.
2. Ask your Cleaner Core chat to save the new door code. It gives you a one-time secure link. Enter the code there, never in a text or a group.
3. To offboard a cleaner, have that cleaner reply STOP, or tell the scheduler to remove them.
4. Confirm the next cleaner. The code is not sent again until that cleaner has opted in and the guests have left.

A text that contains the code, or the words "door code" followed by digits, opens one "possible code exposure" review for the host and does not repeat the digits.
