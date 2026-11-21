Coffer can publish notes as plain web pages, with the images, audio, video, and PDF files they show. Published pages are **not encrypted**, and they go to a location of their own.

## Pick the notes

- Add `publish: true` to a note's properties, or run **Put the current note on the website**. **Take the current note off the website** removes it.
- To publish every note that does not say `publish: false`, turn on **Publish the whole vault** under **Settings → Coffer → Website**. First list private folders under **Keep off the website**, for example `Private/` or `Templates/`. Then check the preview.

## Where it goes

Add a separate S3 bucket or WebDAV folder, with a key of its own, under **Settings → Coffer → Website**. Coffer does not accept your vault's storage or a shared folder's storage. Make the location public through your storage provider. The command line can also write the site to a folder, to put on any web host.

## Publish

Run **Publish notes to the website…**. Coffer shows the new, changed, and deleted files before it uploads anything. It uploads only what changed, and deletes pages you took off.

## What the pages hold

Each note becomes a page at its vault path, with a front page, backlinks ("Linked from"), and one stylesheet for light and dark. Pages have no scripts and no trackers.

Coffer leaves out note properties (except `title`), `%%comments%%`, HTML comments, hidden folders, and conflict copies. Links to notes that are not published show as plain text. Coffer renders Markdown itself, so plugin syntax such as Dataview or Mermaid shows as text.

> [!caution] Privacy
> Page addresses contain file and folder names. Images go up unchanged, with any location data inside them. A page you remove can stay in caches, in copies others made, and in old versions in a versioned bucket.

## This site

This site is Coffer's own `docs` folder: these notes, with `publish` turned on for the whole folder. On each change to the repository, a GitHub workflow runs:

```sh
node dist/coffer.js publish --config=docs/coffer.json
```

That writes the pages to a folder, and GitHub Pages serves it.

Next: [[Command line]].
