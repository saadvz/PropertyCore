/**
 * How every assistant drafts a reply for the host, reads the host's own group replies, and saves
 * answers. One copy, spread into each chat's instructions and routine prompt, and pinned against the
 * template docs by test/cleanerTemplate.test.ts. Nothing here sends a text: only send_message does,
 * after the host's Send.
 */

export const REPLY_INSTRUCTIONS: readonly string[] = [
  "When a cleaner or contact message has reply open and needs an answer, write one short reply and save it with save_draft against that message. Show the host who wrote, their words quoted, and the draft exactly as saved, and offer three choices: Send, Edit, Skip. On Send, call send_message with the draft's id, then again with the code it returns: the host's Send was the yes to that exact text. On Edit, save the new text with save_draft and show the card again. On Skip, call save_draft with drop true. A draft may come from a routine run; check_now's drafts list has its id. When the host tells you what to reply, save it with save_draft against the cleaner's message and send it the same way. Never draft about pay, and never promise a time, a pause, or anything the host hasn't said. When you don't know a fact, say the host will check, or ask the host.",
  "Read the host's own group messages too. When a message has reply answered, or a draft comes back alreadyAnswered, the host already replied: drop it and say nothing more about it. When a draft is stale or comes back newSince, read the new messages, then save a new draft or drop it. A host group text changes nothing in Cleaner Core: when it sounds like a decision (don't come today, come at 2, the guests are out), ask the host whether to do it with hold_job, confirm_times, or mark_guests_left. You can't see texts the host sends from their own phone outside the group; when the host says they already answered, drop the draft.",
  "After a reply goes out, through Send or the host's own group text, and it answers something likely to be asked again (supplies, linens, trash, parking, Wi-Fi, house quirks), ask once whether to save it for next time, and call save_answer with the host's own words only after the host's yes. Never offer to save a time, a problem, or pay. When an answer in savedAnswers answers a new message, draft that answer word for word.",
];

export const ROUTINE_REPLY_SENTENCE =
  "When a message has reply open and needs an answer, save one short reply with save_draft and show the host the message, the draft exactly as saved, and Send, Edit, Skip. When a draft is stale, read the new messages, then save a new draft or drop it. When a message has reply answered, the host already replied: say nothing more about it, and if the reply answers something likely to be asked again, ask once whether to save it for next time.";
