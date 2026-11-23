/**
 * What counts as touching UI: the one definition, read by dispatch's admissibility check
 * and by its design-judge trigger, and imported by the test that keeps it honest. The test
 * used to carry its own copy of the regex, which could stay green while this one drifted.
 *
 * Two clauses, because one is not enough. Markup and stylesheet extensions are UI wherever
 * they live. And ANY source file under a UI directory is UI too, including plain `.ts`,
 * which the first version missed: this repo's own design canaries seed emoji, placeholder
 * content and a silenced empty state into `src/web/render.ts`, and every one of them would
 * have bypassed the design judge entirely (doctrine#15 review).
 *
 * Broad on purpose, with one exception: **test data is not UI.** A fixture article page,
 * a recorded HTML response, a test file: none is rendered by the app, so none is a screen
 * the design judge could look at. Counting them was not the cheap false positive the broad
 * rule assumed. On a target with no `design` block a false positive does not cost one judge
 * run, it parks the unit as `ui-inadmissible`, and one target's first collector unit
 * parked on three fixture `.html` pages it needed to test against. On a target
 * WITH a design block it would buy a design-judge run on every scraper, feed and embed unit.
 */
const UI_FILE = /\.(css|scss|less|html|htm|ejs|hbs|tsx|jsx|vue|svelte)$|(^|\/)(web|ui|views|public|components|screens|templates)\/.*\.(ts|js|mjs|cjs|json)$/i;

/** A test tree or fixture tree segment anywhere in the path, or a test file by its name:
 *  the `.test.`/`.spec.`/`.cy.` (Cypress) marker, however many suffixes follow it
 *  (`x.test.browser.tsx`, `Button.cy.tsx`). */
const TEST_DATA = /(^|\/)(test|tests|__tests__|fixtures|__fixtures__|__snapshots__)\/|\.(test|spec|cy)(\.[a-z0-9]+)+$/i;

export function isUiFile(path: string): boolean {
  const p = path.trim().replace(/\\/g, "/");
  return p.length > 0 && UI_FILE.test(p) && !TEST_DATA.test(p);
}
