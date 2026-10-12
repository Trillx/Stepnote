# Using Stepnote

## Open the panel

Open an ordinary HTTP or HTTPS page, then click Stepnote's toolbar button. You can also use `Ctrl+Shift+Y` if the shortcut is available. The native side panel opens alongside the page. Its home shows **Start Capture**, a short privacy warning, and **Your guides**. Fuller details are under the collapsed **Privacy & limits** disclosure.

## Capture a procedure

### Start

Choose **Start Capture**. Until site access is granted, the panel first explains why it is needed. **Allow and start** then opens Chrome's own prompt ("Read and change all your data on all websites"). Allow it so capture can follow you into new tabs, page loads, and other windows. **Only this tab** starts without asking.

Then click and type through your procedure. Clicks and ordinary text entry each become steps. Instructions show the control name in bold (Click **Save**).

### Review while you record

New cards follow by default. Hover over the list or scroll to review without being pulled back down. Return to the bottom and move the pointer out of the list to resume following. In-place text updates, status updates, and deletion do not jump the list or steal page focus.

- **Pause** suppresses new captures. **Resume** continues in the web page currently in focus.
- Clicking a screenshot opens a larger preview and pauses recording. Closing the preview never resumes it automatically.
- Delete individual steps with their card's **Delete** control. Remaining cards renumber in order.

### Page changes

Arriving at a new page without a click (an address you typed, a tab you switched to, a single-page app route) adds a "Go to *page*" step. Navigation a recorded click caused within five seconds (that tab navigating, or a tab it opened) does not. Reloading a page adds nothing.

### Full page screenshots

**Full page screenshot** (in the panel while capturing or paused, and **Full page** on the on-page bar) scrolls the page and stitches one tall screenshot into a step, "Full page: *page title*".

- When the document itself scrolls, the whole page is captured. In apps that scroll an inner panel, the largest visible scrolling area is extended in place, with headers and menus shown once and any footer moved to the bottom.
- Sticky headers sit in their natural place, fixed bars and widgets appear once, Stepnote's own controls are hidden, and the page's scroll position is put back afterwards.
- Automatic blur runs on every slice and fails closed.
- Chrome allows about two screenshots a second, so a long page takes a few seconds. Keep the tab in front until it finishes.
- Pages are captured up to 12,000 px tall, and the step label says when a page was cut off.

### Finish

Choose **Complete Capture** to stop and review the saved guide. Then:

- **Export HTML** downloads a portable procedure with images embedded.
- **Edit guide** opens the guide editor.
- **Done** files the completed guide in your library and returns to the home screen. Starting a new capture does the same automatically.

**Discard Capture** during recording, or **Delete recording** after completion, asks for confirmation in the panel, with **Keep capturing** or **Cancel** as the focused default. Export first if you need a copy. Review images before sharing.

## Edit a guide

In the guide editor you can:

- Edit the title and add a description.
- Rewrite any step's instruction. The reset icon restores the recorded text. Wrap words in `**double asterisks**` for bold.
- Add notes to steps.
- Use the **+** between entries to insert a header, tip or alert.
- Reorder with the arrow buttons or by dragging the handle.
- Choose a **Click marker** style, circle or box. It applies in the editor and in every export.

Edits save automatically, including during a live capture.

### Screenshot editor

**Blur or crop screenshot** opens an image editor with blur, crop, **Box**, **Arrow** and **Text** tools, plus **Zoom to click** (a half-size crop around the click). Everything is baked into the saved image. Apply replaces the stored image; the original pixels are not kept.

### Export

**Export** offers:

- **Word document** (.docx), with click markers drawn into the images.
- **PDF**, which opens a print-ready page. Choose **Save as PDF** in Chrome's print dialog.
- **Web page** (.html).

Shared exports omit capture coordinates and the author-facing privacy notes.

## Your guides

The panel home and the editor page (opened without a guide) list **Your guides**, newest first, with search across titles, descriptions and step text. Open any guide to edit or export it. Deleting from the editor removes only that guide.

## Guide me

**Guide me** walks a saved guide on the live site. Guides captured on the site in the active tab appear under **On this site** in the panel, each with **Guide me**.

A dimmed overlay spotlights each step's control with a card: Step N of M, the instruction, note and tips, and Back / Next / Exit. Clicking the real control, finishing a text field, or reaching a "Go to" page moves on. Walkthroughs continue across page loads in that tab.

When a control cannot be found, the card shows the step's screenshot and, if the step is on another page, an **Open page** link. Full page steps are shown as a reference.

New captures record a fingerprint of each clicked control (role, accessible name, short text, id and stable attributes, selector, position; never values) so it can be found again. Guides captured before fingerprints existed fall back to screenshots.

## Settings

Open **Settings** with the gear in the panel.

- **Guide count** shows the number of your guides for the current site on the toolbar icon.
- **Stepnote button** shows a floating button on web pages that opens the side panel. **Hidden on sites** manages exclusions; the button's × adds the current site.
- **Capture controls** chooses between the side panel plus an on-page Pause/Complete bar (hidden during each screenshot and never recorded), or the side panel only.
- **Tidy up steps** merges a field click into the typing that follows it and drops repeated clicks within a second when a capture completes, without changing edited steps.

Guide count, the on-screen button, and walkthroughs across pages need the site access requested at Start.

**Blur private info automatically** is a toggle on the panel home rather than in Settings. See [Automatic blur](privacy.md#automatic-blur).
