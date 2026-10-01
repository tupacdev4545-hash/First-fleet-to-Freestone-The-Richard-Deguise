# The Deguise Family Tree — website

A zoomable, searchable family tree that runs entirely as static files on
CloudFront, plus one Lambda for "suggest a person" submissions. No servers, no
load balancers, no database to babysit.

221 people across eight generations, transcribed from the three original chart
sheets — Guise of Gundaroo, the Bradney continuation, and the descendants of
Alice and Neville Rock. See `TRANSCRIPTION-NOTES.md` for every place the paper
was ambiguous.

Zoom right out and the tree draws itself as coloured blocks, so the shape of the
family reads at a glance; zoom in and the cards fill out with names, dates and
photograph counts. Clicking a family in the legend flies the camera to it and
dims everyone else.

```
src/data/tree.json     ← the whole family. This is the file you edit.
src/lib/layout.ts      ← generation/union layout engine
src/components/        ← canvas, person panel, submission form
api/index.mjs          ← the one Lambda: validates, stores, emails you
infra/template.yaml    ← S3 + CloudFront + DynamoDB + SES, one CloudFormation stack
scripts/               ← bootstrap, deploy, list submissions
```

## Running it locally

```bash
npm install
npm run dev
```

Without `VITE_API_URL` set, the submission form falls back to opening the
visitor's mail client addressed to `VITE_ADMIN_EMAIL`. That is a perfectly
reasonable way to run the site before the AWS side exists.

## Deploying to AWS

You need the AWS CLI configured, and `zip` available.

```bash
./scripts/bootstrap.sh you@example.com ap-southeast-2   # once
./scripts/deploy.sh                                     # every time after
```

`bootstrap.sh` creates the stack, asks SES to verify your email (click the link
it sends you), prompts for the family passcode, and writes `.env` with the API
URL. `deploy.sh` builds the site, ships the Lambda, syncs S3 and invalidates
the CDN.

Rerun `bootstrap.sh` — not just `deploy.sh` — after any change to
`infra/template.yaml`, and whenever you want to change the passcode.

### Custom domain

One script does the lot — certificate, DNS instructions, validation wait,
stack rebuild and deploy:

```bash
bash scripts/domain.sh
```

It stops halfway to print the CNAMEs you need to add at your DNS host and waits
for you. If you would rather it did that part too, give it a Cloudflare API
token with Zone:Read and DNS:Edit on the zone:

```bash
export CF_API_TOKEN=...
bash scripts/domain.sh
```

Two things that catch people out and the script guards against:

- The certificate **must** be in `us-east-1`, wherever the site lives.
  CloudFront reads certificates from nowhere else.
- Every record must be **DNS only** — Cloudflare's grey cloud. A proxied
  validation record never validates, and a proxied site record puts a second
  CDN in front of CloudFront.

The old CloudFront address keeps working after the domain is attached, so links
already sent out do not break.

### Rough running cost

| Piece | Cost at this scale |
| --- | --- |
| S3 storage + requests | cents |
| CloudFront | free tier 1 TB/month for the first year, then ~$0.11/GB out of Sydney |
| Lambda | free tier covers 1M requests/month |
| DynamoDB on-demand | free tier covers 25 GB and this write volume |
| SES | $0.10 per 1,000 emails |
| Route 53 hosted zone (if you use one) | $0.50/month |

So: about a dollar a month, dominated by the hosted zone if you add one.

## What visitors can contribute

Open anyone's record and there are three ways in:

- **A photograph — published instantly.** Every empty gallery slot is a **+**
  button. Anyone who types the shared family passcode has their photograph on
  the tree for everyone within seconds.
- **Their life story — published instantly.** Same passcode, same immediacy.
  The editor is prefilled with what the tree says now, so each writer extends
  the last rather than talking past them.
- **A relative** — child, parent, spouse or sibling. This one still waits.

Photographs and stories go up on their own. Anything that changes the *shape*
of the tree — a new person, a new marriage — still comes to you first, because
that is where the real judgement calls are.

A story written **without** the passcode is not refused: it queues for your
approval, the way everything used to. A distant cousin who finds the site and
remembers something should not be turned away at the door. A *wrong* passcode
is an error, though, not a silent demotion — otherwise a typo would look to
them like the site had swallowed their work.

### The family passcode

One shared word, set when you run `bootstrap.sh`. It is stored only in AWS (a
`NoEcho` CloudFormation parameter, read by the Lambda from its environment) and
never written into `.env`, the repo or the bundle. Rerun `bootstrap.sh` to
change it; press Enter at the prompt to keep the one the stack already has.

What happens when someone adds a photograph:

1. The browser asks the Lambda for a presigned PUT. The Lambda checks the
   passcode — constant-time, against a SHA-256 digest — and only then signs one.
2. The browser uploads straight to `photos/live/` in the site bucket, so the
   bytes never pass through the Lambda and CloudFront serves them immediately.
3. The Lambda records it in DynamoDB as `status: live` and rewrites
   `gallery.json` from the table. Rebuilding from the table rather than
   appending means two people uploading at the same moment cannot lose each
   other's work.
4. Every visitor's browser fetches `gallery.json` on load. It has a
   caching-disabled behaviour in CloudFront, so a new photograph is live for
   everyone without a redeploy.
5. You get an email with the photograph inline and a **Take it down** button.
   One click deletes the file, marks the row `removed` and rebuilds the gallery.
   The link is HMAC-signed with the passcode, so rotating the passcode
   invalidates every outstanding take-down link.

Life stories follow the same path, minus the upload: passcode checked, row
written as `status: live`, `gallery.json` rebuilt, email sent showing what it
**now reads** and what it **was**.

### Stories overwrite; photographs accumulate

This is the one asymmetry worth understanding. A person has five photo slots
but only one story, so publishing a story replaces the one before it. Four
things keep that safe:

- The editor **starts from the current text**, so the natural act is to extend.
- Every version is kept in DynamoDB. `./scripts/submissions.sh all` is the
  history.
- **Take it down** on any story falls back to the previous published one, or to
  the blurb in `tree.json` if there was none. It is a real undo chain, not just
  a delete.
- The email shows the new text and the old text together, so you can see at a
  glance whether something was lost.

The passcode is a door, not a vault. It keeps out drive-by strangers and search
engines; it does not stop someone the family gave it to. That is the right
trade for a family archive — but if it leaks, rerun `bootstrap.sh` with a new
one and the old one stops working immediately.

Photographs live in the site bucket, which is versioned, so even a deletion is
recoverable from S3 if you regret it.

### One thing to be careful of when deploying

`gallery.json` and everything under `photos/live/` exist **only** in the bucket
— they are not in `dist/`. `deploy.sh` syncs with `--delete`, so both are
explicitly excluded from the sync. Do not remove those two `--exclude` lines:
without them every deploy silently wipes every contribution the family has made
since the last one.
### The spouse question, and who it is asked about

Adding a partner to someone who already has one raises an obvious question:
what happened to the first partnership? How that question is handled depends
entirely on whether the people involved are still alive.

**Both have died** — the form asks. Widowed, divorced, separated, still
together, or the tree has it wrong; then who that person was with afterwards.
For a couple who married in 1853 this is ordinary genealogy.

**Anyone in that partnership is still living** — the form does not ask, and
does not offer a box to speculate in. It says plainly that the tree already
records another partner, that nothing is being removed, and that the archivist
will check with the family. The proposal reaches you flagged **"check this one
privately"**. A public form is no place for a stranger to assert that a living
person's marriage ended.

The test is `hasDied()` in `src/lib/person.ts`: a person counts as living until
the record carries a death date. So a record with no death date is treated as
the more sensitive case, which is the right way round for the error to fall.

Nothing is ever deleted either way — a person can hold several partnerships —
but the record ends up saying which one is current, which is the thing family
trees usually get wrong.

## The approval loop

What is left of it: new relatives, and stories written by someone without the
passcode. Photographs never queue.

1. Someone contributes. It appears on their screen immediately, marked
   **Pending**, so the act of contributing feels like it worked.
2. The Lambda validates it, writes it to DynamoDB with `status: pending`, and
   emails you.
3. You pass it to the relevant branch of the family to confirm.
4. Once confirmed, put it into `src/data/tree.json` and run
   `./scripts/deploy.sh`.

```bash
./scripts/submissions.sh          # waiting on you
./scripts/submissions.sh live     # already on the site
./scripts/submissions.sh removed  # taken down
./scripts/submissions.sh all      # everything, including superseded stories
```

Nothing that reshapes the tree changes on its own. The contributor's own
browser shows it until they reload; everyone else sees it only after you
publish.

### Folding live contributions into the data file

What the family publishes is a layer on top of `tree.json`, not part of it. The
browser merges the two: `tree.json` photos first, then live ones; live story if
there is one, otherwise the record's blurb. That split can stand indefinitely.

To make something permanent — say a story has settled and you want it in the
repo — paste the text into that person's `blurb` in `tree.json`, copy any
photograph out of the site bucket into `public/photos/` and add it to their
`photos` array, then take the live rows down with the links in their emails and
deploy. The merge means the page looks identical before and after.

## The data file

Two arrays. People, and the unions that join them.

```jsonc
{
  "people": [
    {
      "id": "p-mary-ann-brownlow",
      "name": "Mary Ann Brownlow",
      "nee": "de Guise",          // shown as "née"
      "sex": "F",
      "born": "c. 1835",
      "bornPlace": "New South Wales",
      "died": "1855",
      "diedPlace": "Goulburn Gaol, NSW",
      "branch": "guise",          // colours the card; see BRANCH_ORDER
      "tags": ["Goulburn", "1855"],
      "blurb": "…",
      "photos": [{ "src": "/photos/mary-ann-1.jpg", "caption": "…" }],
      "unverified": true          // shows a small dot until sourced
    }
  ],
  "unions": [
    {
      "id": "u-2",
      "partners": ["p-mary-ann-brownlow", "p-william-brownlow"],
      "children": [],
      "married": "c. 1853",
      "marriedPlace": "Goulburn, NSW"
    }
  ]
}
```

Branches are the twenty families with people of their own on this tree, split
into the line it descends along — `guise`, `brownlow`, `bradney`, `jones`,
`rock` — and the families that married in and left descendants: `freestone`,
`staber`, `bastock`, `hayes`, `mcenally`, `mckenzie`, `goodwin`, `ritchie`,
`johnston`, `taylor`, `touzell`, `mciver`, `newton`, `robson`, `browne`.
Everyone else is `other`.

A person takes the branch of their birth surname (the `nee` where there is one).
The legend lists all twenty with counts, and clicking one flies the camera to
that family. Give a new family its own colour by adding it to `BRANCH_ORDER`
and `BRANCH_LABELS` in `src/lib/person.ts`, and a `--branch-<id>` value to each
of the three palette blocks in `src/index.css`.

The layout works itself out from those two arrays — generations, spouse pairs,
sibling ordering and the descent lines are all derived. Someone who married
into an already-drawn branch is linked with a dashed line rather than being
drawn twice.

**Photographs** go in `public/photos/` and are referenced as `/photos/name.jpg`.
Up to five show in a person's gallery. Keep them under ~300 KB each; they are
served from the CDN alongside the site.

## What is deliberately not here yet

- An admin web UI — approval is email plus a JSON edit, which is the cheapest
  thing that works.
- Automatic sourcing of historical photographs. There is no reliable free
  source of correctly-attributed portraits for these families, and a wrong face
  in a family archive is worse than an empty frame. Each record instead links
  to a **Trove** newspaper search for that person, which is where the real
  material is.
- The geographic map view. The layout engine and data model do not preclude it;
  add `lat`/`lng` to people and a second view.
- The mobile apps. The same `tree.json` and the same layout engine will drive
  them.
