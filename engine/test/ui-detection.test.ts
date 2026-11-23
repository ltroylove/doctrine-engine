import { describe, expect, it } from "vitest";
import { isUiFile } from "../src/ui-files.js";

/**
 * The UI-detection rule, kept honest by the files this repo's own design canaries actually
 * seed defects into, and by the test data a real target needs.
 *
 * It imports the rule dispatch uses. It used to keep its own copy of the regex, which
 * could stay green while the engine's drifted.
 */
describe("UI detection — what sends a diff to the design-judge", () => {
  it("catches the exact files this repo's design canaries edit", () => {
    // If either of these ever reads false, the design canaries are measuring nothing.
    expect(isUiFile("src/web/render.ts")).toBe(true);
    expect(isUiFile("src/web/public/css/app.css")).toBe(true);
  });

  it("catches markup and stylesheets wherever they live", () => {
    for (const f of [
      "app.css", "src/styles/theme.scss", "index.html",
      "src/views/invoice.ejs", "src/billing/InvoiceRow.tsx", "x.vue", "y.svelte",
    ]) {
      expect(isUiFile(f), f).toBe(true);
    }
  });

  it("catches ordinary source under a UI directory", () => {
    for (const f of [
      "src/web/respond.ts", "src/ui/format.js", "src/components/table.ts",
      "src/screens/close.ts", "app/templates/mail.js", "public/app.mjs",
      "src/web/views/queue.tsx",
    ]) {
      expect(isUiFile(f), f).toBe(true);
    }
  });

  it("leaves non-UI source alone, so the design-judge is not run on a migration", () => {
    for (const f of [
      "src/db/open.ts", "src/core/money.ts", "engine/src/dispatch.ts",
      "package.json", "docs/program/ARCH.md", "src/sync/qbo.ts",
      "test/unit/money.test.ts", "scripts/design-conformance.mjs",
    ]) {
      expect(isUiFile(f), f).toBe(false);
    }
  });

  it("is not fooled by a path that merely contains a UI word", () => {
    // "webhooks" contains "web", and a webhook handler is not a screen. The directory
    // must be the whole segment.
    expect(isUiFile("src/webhooks/stripe.ts")).toBe(false);
    expect(isUiFile("src/publisher/feed.ts")).toBe(false);
  });

  it("does not count test data as UI: a fixture page is not a screen", () => {
    // A target's first collector unit parked ui-inadmissible on exactly these three:
    // article pages its tests fetch from a fixture server. The app never
    // renders them, so there is nothing for a design judge to look at.
    for (const f of [
      "test/fixtures/articles/a-jsonld.html",
      "test/fixtures/articles/b-opengraph.html",
      "tests/data/feed.html",
      "src/collect/__fixtures__/page.htm",
      "src/web/__tests__/render.test.ts",
      "src/web/views/queue.test.tsx",
      "src/web/render.test.browser.tsx",
      "src/ui/button.spec.e2e.ts",
      "src/web/button.test.module.css",
      "src/components/Button.cy.tsx",
      "src/web/views/__snapshots__/queue.test.tsx.snap.html",
      "fixtures/oembed/tiktok.html",
    ]) {
      expect(isUiFile(f), f).toBe(false);
    }
  });

  it("still counts real UI that only shares a word with test data", () => {
    // The exclusion is a whole path segment or a test-file suffix, never a substring.
    for (const f of [
      "src/web/views/testimonials.tsx",
      "src/web/views/latest.tsx",
      "src/web/public/fixtures-legend.css",
      "src/web/contest.ts",
    ]) {
      expect(isUiFile(f), f).toBe(true);
    }
  });

  it("normalises Windows separators and whitespace from git output", () => {
    expect(isUiFile("  src\\web\\render.ts  ")).toBe(true);
    expect(isUiFile("test\\fixtures\\articles\\a.html")).toBe(false);
    expect(isUiFile("")).toBe(false);
  });
});
