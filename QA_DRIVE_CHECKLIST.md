# Manual Drive check (real Google, two devices A and B)
1. A: connect, save one dialog. B: connect. Both show the dialog; nothing lost on either side.
2. A and B both edit different dialogs, then save within a few seconds. After one more sync on each, both hold both edits.
3. A and B edit the same dialog; the later edit wins, the other is in the local backup.
4. Close the tab, reopen: the button says Connect; reconnect repeats the pending save.
5. Autosave: edit once, wait. One write after about 30 s. Edit 5 times quickly: still one write. No edits: no writes (check Drive "modified" time).
6. "Save to Drive" button saves at once, even right after an autosave.
7. Empty library on a new device, connect: Drive dialogs arrive; Drive file is not emptied.
8. Turn network off during save: short error message, dialogs stay on the device.

# Device check (phone and tablet, portrait) - QA-04
9. Sign in from a phone and a tablet; the Start button and every header button are easy to hit (44 px).
10. Leave the "Method" mode without rotating the screen.
11. iPhone: tap into the chat field and the Google AI key field; the page must not zoom or jump.
12. Open History: the list scrolls, the current dialog is marked, "On Drive" / "Only here" is shown.
