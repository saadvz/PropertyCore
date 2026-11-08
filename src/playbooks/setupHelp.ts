/**
 * The one setup-help link. Swap this line when a shorter docs address exists.
 * The repository is public, so this page opens for a landlord the day it is on master.
 * The page does not name a person to contact.
 */
export const SETUP_HELP_URL = "https://github.com/saadvz/PropertyCore/blob/master/docs/setup-help.md";

/** The same ending on every failure line. Nothing follows the link. */
export const SETUP_HELP_ENDING = `If it keeps failing, the setup help page has the usual fixes: ${SETUP_HELP_URL}`;

const PAGE = `# Setup help

If something in setup keeps failing, find it here. Each note is what you see, then the one thing to do next.

## The connection didn't go through

You see a code, and the connection still isn't allowed.

Allow it one more time. If the code doesn't match, wait for a new one.

## It isn't up yet

You ask, and setup hasn't started.

Wait a moment, then ask again.

## You can't pick how people text you

You picked a way for people to text you, and it didn't stick. Or there is nothing to pick.

Pick again from the list you are shown. If there's nothing to pick from, texting can't be set up yet. Whoever set up your Tour Core hosting can add a texting service.

## The texting login didn't save

You were asked for the texting login in private, and it didn't save. Or the private link won't open.

Open the private link again and enter the login there. Don't paste it in the chat.

## The texting number isn't one you can use

The number you picked isn't on the list, or the list is empty.

Pick a number from the list. If the list is empty, finish the texting login first.

## Texting isn't working right now

Texts aren't going through, and you are not shown an error code.

Ask for texting to be checked again. That check does not text anyone.

## The private copy wasn't set up

You wanted a private copy of your records, and it isn't ready. Or a folder you already use can't be reached.

You can skip the copy. If you still want it, approve that folder one more time.

## The address won't save

You don't have a street address saved yet, or the address you were shown is wrong.

Say the street, city, state, and ZIP again. If one part is wrong, say just that part.

## The kind of place isn't saved

You were asked if this is a single-family home, a multifamily home, or one apartment or condo, and it isn't saved.

Say which kind it is.

## The places people can tour aren't saved

A place, a name, or a detail didn't save.

Name each place people can tour. For a whole home, the street is fine if you don't have a nickname. If one detail didn't save, say that detail once more, or say not to list it.

## A door or a way through is missing

One place still has no door, or no way from the front door to the door people tour.

Say how someone walks in, from the front door to the door they tour.

## The hours didn't save

The days and times people can tour didn't save.

Say the days and times that are already saved. They can keep those.

## The help number didn't save

The number stuck visitors can call didn't save.

Say the number again, or skip it.

## Tour updates didn't connect

You asked to be texted when someone books, starts, or finishes a tour, and the updates didn't connect. Or the private link won't open.

Try the private link again. You can also skip updates.

## The check didn't pass

Something still needs a fix before a tour can run.

Ask what still needs a fix, then fix that one thing and check again. Nobody is texted, and no real door opens.

## The practice tour didn't pass

The practice tour didn't finish.

Fix the thing that failed, then run the practice tour again. Nobody is texted, and no real door opens.

## It isn't published

You said yes, and it still isn't published.

Nothing went live, so it's safe to say yes again.

## Tour Core isn't running

You ask for something and nothing comes back.

Wait a moment and ask again.

## Your records aren't saved anywhere permanent yet

Tour Core is running, but your records aren't saved anywhere permanent yet, so the next update could erase them.

Whoever set up your Tour Core hosting needs to attach permanent storage. Until then, hold off on updating Tour Core.

## Records couldn't be checked

You can't tell whether your records are saved.

Ask for them to be checked again.
`;

/** Full page. It does not end with a contact line. */
export const SETUP_HELP_PAGE = PAGE;
