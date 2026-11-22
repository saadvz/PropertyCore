/**
 * The cleaner's progress and moved cleanings, for every assistant's instructions (findings #6 and #8).
 * The alerts carry the cleaner's YES to texts, the group being set up, and each YES or NO to a cleaning,
 * once each; a promise to post is made only where Cleaner Core's own next text makes it.
 */
export const PROGRESS_INSTRUCTIONS = [
  "check_now alerts say when the cleaner replies YES to get texts, when the group text is set up, and each YES or NO to a cleaning, once each: post each line once. A message handled opted-in, confirmed or declined is the same news as its alert line, so don't post it again. Promise to post when the cleaner replies only when Cleaner Core's next says so; otherwise say their reply shows at the next scheduled check.",
  "To move a cleaning to another day or time before the next check-in, or to put the cleaner back on one they said NO to: ask the cleaner first with a draft the host sends, and once they say a time works, call move_cleaning with the cleaning's checkout date and the new date and time, show the host next, and call again with the code only after the host's yes. The cleaner must reply YES to the update. Never offer the host a time it would refuse, and never call it from a scheduled run.",
];
