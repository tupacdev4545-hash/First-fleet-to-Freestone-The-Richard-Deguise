# Wiring guide

Ordered by priority. Each file lists its assumptions at the top. Check them
against the real code, because none of this has been run against the repo yet.

## 1. Adding a person (top priority)

**How it works:** someone proposes a person, and the archivist email gets an
"Add to the tree" button. That button opens a confirm page in a new tab, and
"Add to the tree" on that page puts them on the site for everyone. There's no
redeploy and no editing of `tree.json`.

**Lambda**, in `lambda/approve.mjs`:

1. At the top of the main handler:
   ```js
   const r = await handleApprove(event, { signingKey, rebuildGallery });
   if (r) return r;
   ```
2. In the email for person submissions, beside "Take it down":
   ```js
   approveButtonHtml(approveUrl(FUNCTION_URL, submission.id, signingKey))
   ```
   Remove the "edit src/data/tree.json and run deploy.sh" line from the email.
3. In `rebuildGallery()`, add `gallery.additions = toAdditions(items);`
4. When people are added, the "Take it down" handler should set the row to
   `taken_down` and rebuild. They then drop off the site on the next load.

**Form.** The submission must carry `relativeId` (the tree id, not just the
name), plus `unionId` when the parent has more than one marriage. Without
`unionId`, the child goes under the most recent marriage.

**Browser**, in `src/lib/additions.ts`. Where `tree.json` and `gallery.json`
are merged, before layout:
```ts
const tree = applyAdditions(record, gallery.additions ?? []);
```
Added people carry `live: true` if you want to style them (a small "new" mark).

**Folding back in.** Approved people can be copied into `tree.json` whenever
convenient; `applyAdditions` skips anyone whose id is already there.

**Email deliverability.** Send from a verified domain address (for example
`archivist@guisefamilytree.com`, with DKIM records in Cloudflare) and set
Reply-To to the contributor. That removes Gmail's "Be careful" banner, which
otherwise sits right above a button that changes the tree.

## 2. Photos: permanent, five per person, choose the main one

These are in `lambda/photos.mjs` and `src/components/PhotoCarousel.tsx`.
Stories and photos still publish live, as now.

- **Five slots per person.** The five slots include photos already in
  `tree.json`. They're claimed with a conditional counter, so two uploads at
  the same moment can't go past five.
- **Photos are permanent.** Once a photo is up, nobody with the passcode can
  remove or replace it. Upload keys are made on the server, and the signed URL
  can only create a file, not overwrite one. Delete any remove or replace
  action the main handler currently allows with just the passcode.
- **The archivist can still take a photo down.** The take-down link still
  works, and it frees the slot: call `releaseSlot(personId)`, and also delete
  `primary#personId` if the removed photo was the main one.
- **Anyone with the passcode can choose the main photo.** Add a `setPrimary`
  action that calls `setPrimary()`. Then add
  `gallery.primary = toPrimaryMap(items)` to `rebuildGallery()`.
- **The carousel.** It shows the main photo first, marked "Main photo", with
  swipe and arrows and a thumbnail strip. "Make this the main photo" sets the
  main photo for everyone. It also shows how many of the five are used, and an
  add button until all five are taken.
- **Upload flow.** The browser's PUT must send the header `If-None-Match: *`,
  which is returned as `uploadHeaders`.
- **One permission to add.** The Lambda role needs `s3:GetObject` on
  `tree.json` in the site bucket.

## 3. Mobile zoom

This is in `src/lib/panzoom.ts`.

- Replace the canvas's current touch and wheel handling with
  `attachPanZoom(canvasEl, { initial, onChange })`.
- Find whatever re-fits the whole tree on `resize`, and wrap it in
  `onRealResize(fit)`. The iPhone address bar sliding in and out fires resize,
  and is the most likely cause of the random zoom-all-the-way-out.
- In `index.html`, keep `<meta name="viewport" content="width=device-width,
  initial-scale=1">`. The canvas already blocks browser zoom on itself, so the
  rest of the site stays zoomable for anyone who needs larger text.
