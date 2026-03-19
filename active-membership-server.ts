// active-membership-server.ts
// Express server + Stagehand v3 browser automation
//
// FIXES in this version:
//   1. Program link click — waits for table to render, uses text= selector
//      (which triggers Stagehand's shadow-DOM pierce fallback automatically)
//   2. Save & Complete — uses text= selector so it pierces sera-modal shadow DOM
//   3. Date fields — uses label-based DOM walk + locator.fill(), no AI
//   4. No stagehand.act() anywhere — zero Gemini / schema validation calls
//
// Modal variants:
//   10-Year / 5-Year plans  →  Starts On  +  Ends On
//   Auto-Renew / other      →  Starts On  +  Next Billing Date

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

// =============================================================================
// TYPES
// =============================================================================

type SPage        = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing" | "unknown";

interface MembershipRow {
  soldOn: string;
  invoice: string;
  job: string;
  customer: string;
  program: string;
  rowIndex: number;
}

interface ProcessedEntry {
  customer: string;
  job: string;
  program: string;
  soldOn: string;
  startsOn: string;
  secondDateField: string;
  secondDateValue: string;
  message: string;
}

interface FailedEntry {
  customer?: string;
  job?: string;
  program?: string;
  soldOn?: string;
  rowIndex?: number;
  message: string;
}

interface TaskResult {
  success: boolean;
  message: string;
  processedCount: number;
  failedCount: number;
  processed: ProcessedEntry[];
  failed: FailedEntry[];
  elapsedMinutes: number;
  sessionUrl: string;
}

// =============================================================================
// HELPERS — pure date math
// =============================================================================

function getModalVariant(programName: string): ModalVariant {
  const n = programName.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

function calcSecondDate(soldOn: string, programName: string): string {
  const parts = soldOn.split("/");
  if (parts.length !== 3) return soldOn;
  const [month, day, yearStr] = parts;
  const year = parseInt(yearStr, 10);
  const n    = programName.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  return `${month}/${day}/${year + add}`;
}

// =============================================================================
// HELPERS — page interactions (pure CDP, no AI)
// =============================================================================

/**
 * Wait for the memberships table to appear and return all valid rows.
 * Retries up to maxWaitMs before giving up.
 */
async function waitForTableRows(page: SPage, maxWaitMs = 10000): Promise<MembershipRow[]> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const rows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const result: MembershipRow[] = [];
      document.querySelectorAll("table tbody tr").forEach((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;
        const soldOn   = cells[0]?.textContent?.trim() ?? "";
        const invoice  = cells[1]?.textContent?.trim() ?? "";
        const job      = cells[2]?.textContent?.trim() ?? "";
        const customer = cells[3]?.textContent?.trim() ?? "";
        const program  = cells[4]?.textContent?.trim() ?? "";
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        if (soldOn.includes("#") || program.includes("#")) return;
        result.push({ soldOn, invoice, job, customer, program, rowIndex: idx });
      });
      return result;
    });
    if (rows.length > 0) return rows;
    await page.waitForTimeout(500);
  }
  return [];
}

/**
 * Click a program link by its exact text.
 * Uses the text= selector which Stagehand resolves with its pierce fallback,
 * so it works even if the link is inside a shadow root.
 * Returns true if the click was dispatched.
 */
async function clickProgramLink(page: SPage, programName: string): Promise<boolean> {
  // Primary: text= selector (Stagehand pierces shadow DOM automatically)
  try {
    const loc = page.locator(`text=${programName}`).first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) {
      await loc.click();
      return true;
    }
  } catch {
    // fall through
  }

  // Fallback: DOM evaluate — find <a> by text content and dispatch click
  const clicked: boolean = await page.evaluate((target: string): boolean => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
    const el = links.find(
      (a) =>
        a.textContent?.trim().toLowerCase() === target.toLowerCase() &&
        (a as HTMLElement).offsetParent !== null
    );
    if (el) { el.click(); return true; }

    // partial match fallback (first 12 chars)
    const partial = links.find(
      (a) =>
        a.textContent?.trim().toLowerCase().startsWith(target.toLowerCase().substring(0, 12)) &&
        (a as HTMLElement).offsetParent !== null &&
        !/^\d+$/.test(a.textContent?.trim() ?? "")
    );
    if (partial) { partial.click(); return true; }

    return false;
  }, programName);

  return clicked;
}

/**
 * Wait for the Edit Memberships modal to open.
 * Returns true when a modal is visible.
 */
async function waitForModal(page: SPage, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open: boolean = await page.evaluate((): boolean => {
      // Standard selectors
      const standard = document.querySelector<HTMLElement>(
        '.modal[style*="display: block"], .modal.show, [role="dialog"], [class*="Modal"]:not([class*="backdrop"])'
      );
      if (standard && standard.offsetParent !== null) return true;

      // sera-modal web component — check its shadow root
      const seraModal = document.querySelector("sera-modal");
      if (seraModal && seraModal.shadowRoot) {
        const inner = seraModal.shadowRoot.querySelector<HTMLElement>(".modal, [class*='modal']");
        if (inner && inner.offsetParent !== null) return true;
        // If shadowRoot exists and has content, the modal is open
        if (seraModal.shadowRoot.childElementCount > 0) return true;
      }

      // Check if any h5/h4 with "Edit Memberships" text is visible
      const headers = Array.from(document.querySelectorAll<HTMLElement>("h5, h4, h3, .modal-title"));
      return headers.some(
        (h) =>
          h.textContent?.includes("Edit Memberships") &&
          h.offsetParent !== null
      );
    });
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Detect which second-date field the modal actually shows.
 * Checks both regular DOM and sera-modal shadow root.
 */
async function detectModalVariant(page: SPage): Promise<ModalVariant> {
  return page.evaluate((): ModalVariant => {
    // Check main DOM
    const mainText = document.body.innerText.toLowerCase();
    if (mainText.includes("ends on"))      return "ends-on";
    if (mainText.includes("next billing")) return "next-billing";

    // Check sera-modal shadow root
    const seraModal = document.querySelector("sera-modal");
    if (seraModal?.shadowRoot) {
      const shadowText = seraModal.shadowRoot.textContent?.toLowerCase() ?? "";
      if (shadowText.includes("ends on"))      return "ends-on";
      if (shadowText.includes("next billing")) return "next-billing";
    }
    return "unknown";
  });
}

/**
 * Fill a date input field identified by its visible label.
 * Searches both normal DOM and sera-modal shadow root.
 * Uses triple-click + fill to replace the existing date.
 */
async function fillDateByLabel(page: SPage, labelText: string, dateValue: string): Promise<void> {
  // Assign a stable ID to the input so we can target it with a locator
  const inputId: string = await page.evaluate(
    (args: { label: string; id: string }): string => {
      const { label, id } = args;

      // Helper: find input associated with a label element
      const findInputForLabel = (lbl: HTMLLabelElement): HTMLInputElement | null => {
        const forAttr = lbl.getAttribute("for");
        if (forAttr) {
          const el = document.getElementById(forAttr) as HTMLInputElement | null;
          if (el) return el;
        }
        const sibling = lbl.nextElementSibling as HTMLInputElement | null;
        if (sibling?.tagName === "INPUT") return sibling;
        // Input may be wrapped in a div/span after the label
        let next = lbl.nextElementSibling;
        while (next) {
          const inp = next.querySelector<HTMLInputElement>("input");
          if (inp) return inp;
          next = next.nextElementSibling;
        }
        return lbl.querySelector<HTMLInputElement>("input");
      };

      // Search in a given root (document or shadow root)
      const searchRoot = (root: Document | ShadowRoot): HTMLInputElement | null => {
        const labels = Array.from(root.querySelectorAll<HTMLLabelElement>("label"));
        const lbl = labels.find(
          (el) => el.textContent?.trim().toLowerCase() === label.toLowerCase()
        );
        if (lbl) return findInputForLabel(lbl);
        return null;
      };

      // Try main DOM first
      let inp = searchRoot(document);

      // Try sera-modal shadow root
      if (!inp) {
        const seraModal = document.querySelector("sera-modal");
        if (seraModal?.shadowRoot) {
          inp = searchRoot(seraModal.shadowRoot);
        }
      }

      if (!inp) return "";
      inp.id = inp.id || id;
      return inp.id;
    },
    { label: labelText, id: `__sh_${labelText.replace(/\s+/g, "_").toLowerCase()}_${Date.now()}` }
  );

  if (!inputId) {
    throw new Error(`Could not find input for label "${labelText}"`);
  }

  const loc = page.locator(`#${inputId}`).first();

  // Triple-click selects all existing text, then fill replaces it
  await loc.click({ clickCount: 3 });
  await page.waitForTimeout(150);
  await loc.fill(dateValue);
  await page.waitForTimeout(300);

  // Trigger change event so the app registers the new value
  await page.evaluate((id: string): void => {
    const el = document.getElementById(id);
    if (el) {
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
    }
  }, inputId);
}

/**
 * Click the "Save & Complete" button.
 * Uses text= selector first (pierces shadow DOM).
 * Falls back to searching the sera-modal shadow root directly.
 */
async function clickSaveAndComplete(page: SPage): Promise<void> {
  // Primary: text= selector — Stagehand's pierce fallback handles shadow DOM
  try {
    const loc = page.locator("text=Save & Complete").first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) {
      await loc.click();
      return;
    }
  } catch {
    // fall through
  }

  // Fallback: search sera-modal shadow root and dispatch a real click via CDP
  const btnFound: boolean = await page.evaluate((): boolean => {
    // Search in a root for the button
    const findBtn = (root: Document | ShadowRoot): HTMLElement | null => {
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>("button, input[type='submit'], [role='button']")
      );
      return (
        candidates.find((el) => {
          const txt = el.textContent?.trim().toLowerCase() ?? "";
          return txt === "save & complete" || txt === "save and complete";
        }) ?? null
      );
    };

    // Try main DOM
    let btn = findBtn(document);

    // Try sera-modal shadow root
    if (!btn) {
      const seraModal = document.querySelector("sera-modal");
      if (seraModal?.shadowRoot) {
        btn = findBtn(seraModal.shadowRoot);
        // Also search nested shadow roots one level deep
        if (!btn) {
          seraModal.shadowRoot.querySelectorAll("*").forEach((el) => {
            if (!btn && (el as HTMLElement).shadowRoot) {
              btn = findBtn((el as HTMLElement).shadowRoot!);
            }
          });
        }
      }
    }

    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!btnFound) {
    throw new Error("Save & Complete button not found (checked main DOM + sera-modal shadow root)");
  }
}

// =============================================================================
// MAIN TASK
// =============================================================================

async function runMembershipTask(): Promise<TaskResult> {
  const startTime = Date.now();

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY ?? "",
    },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";
  const processed: ProcessedEntry[] = [];
  const failed: FailedEntry[]       = [];

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page: SPage = stagehand.context.activePage()!;

    // ----------------------------------------------------------------
    // STEP 1 — Login
    // ----------------------------------------------------------------
    console.log("\n[1] → Logging in …");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      const email    = process.env.SERA_EMAIL    ?? "mcc@stratablue.com";
      const password = process.env.SERA_PASSWORD ?? "";

      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(400);

      const clicked: boolean = await page.evaluate((): boolean => {
        const btn = Array.from(
          document.querySelectorAll<HTMLElement>('button, input[type="submit"]')
        ).find(
          (el) =>
            ["sign in", "login", "log in"].some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && el.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!clicked) await page.locator('button[type="submit"]').first().click();

      let loggedIn = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes("/login")) { loggedIn = true; break; }
      }
      if (!loggedIn) throw new Error("Still on login page after 30 s");
      console.log("    ✅ Logged in");
    } else {
      console.log("    ✅ Already logged in");
    }

    // ----------------------------------------------------------------
    // STEP 2 — Navigate to /memberships and read ALL rows ONCE
    // ----------------------------------------------------------------
    console.log("\n[2] → Loading /memberships …");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const allRows = await waitForTableRows(page);
    console.log(`    ℹ️  Found ${allRows.length} row(s):`);
    allRows.forEach((r, i) =>
      console.log(`      [${i + 1}] ${r.soldOn} | ${r.customer} | "${r.program}" | Job #${r.job}`)
    );

    if (allRows.length === 0) {
      return {
        success: true,
        message: "No membership rows found — nothing to process.",
        processedCount: 0, failedCount: 0,
        processed: [], failed: [],
        elapsedMinutes: parseFloat(((Date.now() - startTime) / 60000).toFixed(2)),
        sessionUrl,
      };
    }

    // ----------------------------------------------------------------
    // STEP 3 — Process each row
    // For every row: navigate fresh → click program link → fill modal → save
    // ----------------------------------------------------------------
    for (let i = 0; i < allRows.length; i++) {
      const row             = allRows[i];
      const secondDate      = calcSecondDate(row.soldOn, row.program);
      const expectedVariant = getModalVariant(row.program);

      console.log(`\n[3.${i + 1}] ─────────────────────────────────────────`);
      console.log(`  Customer : ${row.customer}`);
      console.log(`  Program  : "${row.program}"`);
      console.log(`  Sold On  : ${row.soldOn}`);
      console.log(`  Expected : ${expectedVariant === "ends-on" ? "Ends On" : "Next Billing Date"} → ${secondDate}`);

      // Navigate fresh for every row — clears any leftover modal state
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(2000);

      // Wait for table to render before clicking
      const currentRows = await waitForTableRows(page, 8000);
      if (currentRows.length === 0) {
        failed.push({ ...row, message: "Table did not render after navigation" });
        console.log("  ❌ Table not found after reload — skipping");
        continue;
      }

      // ── 3a. Click the program link ─────────────────────────────────
      console.log(`  → Clicking program link: "${row.program}"`);
      const clicked = await clickProgramLink(page, row.program);
      console.log(`  ℹ️  Click dispatched: ${clicked}`);

      if (!clicked) {
        failed.push({ ...row, message: "Could not find program link in table" });
        console.log("  ❌ Program link not found — skipping");
        continue;
      }

      // ── 3b. Wait for modal ─────────────────────────────────────────
      const modalOpen = await waitForModal(page, 6000);
      if (!modalOpen) {
        failed.push({ ...row, message: `Modal did not open. Session: ${sessionUrl}` });
        console.log("  ❌ Modal did not open — skipping");
        continue;
      }
      console.log("  ✅ Modal is open");
      await page.waitForTimeout(500); // let modal fully render

      // ── 3c. Detect actual variant from live DOM ────────────────────
      const actualVariant    = await detectModalVariant(page);
      const variantToUse     = actualVariant !== "unknown" ? actualVariant : expectedVariant;
      const secondFieldLabel = variantToUse === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log(`  ℹ️  Modal variant: "${secondFieldLabel}"`);

      // ── 3d. Set Starts On ──────────────────────────────────────────
      console.log(`  → "Starts On" → ${row.soldOn}`);
      let startsOnSet = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fillDateByLabel(page, "Starts On", row.soldOn);
          console.log(`  ✅ Starts On set (attempt ${attempt})`);
          startsOnSet = true;
          break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Starts On attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(600);
        }
      }
      if (!startsOnSet) console.log("  ⚠️  Starts On could not be set — continuing");

      // ── 3e. Set Ends On / Next Billing Date ────────────────────────
      console.log(`  → "${secondFieldLabel}" → ${secondDate}`);
      try {
        await fillDateByLabel(page, secondFieldLabel, secondDate);
        console.log(`  ✅ "${secondFieldLabel}" set`);
      } catch (e: unknown) {
        console.log(`  ⚠️  "${secondFieldLabel}": ${e instanceof Error ? e.message : e}`);
      }

      // ── 3f. Save & Complete ────────────────────────────────────────
      console.log("  → Clicking Save & Complete …");
      try {
        await clickSaveAndComplete(page);
        await page.waitForTimeout(2500);
        console.log("  ✅ Saved");

        processed.push({
          customer: row.customer, job: row.job, program: row.program,
          soldOn: row.soldOn, startsOn: row.soldOn,
          secondDateField: secondFieldLabel, secondDateValue: secondDate,
          message:
            `${row.customer} | Job #${row.job} | ${row.program}` +
            ` | Starts On: ${row.soldOn} | ${secondFieldLabel}: ${secondDate}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ ...row, message: `Save & Complete failed: ${msg}` });
        console.log(`  ❌ Save failed: ${msg}`);
      }
    }

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Fatal: ${msg}`);
    failed.push({ message: `Fatal: ${msg}` });
  } finally {
    await stagehand.close();
    console.log("\n🔒 Session closed");
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(2);
  const success = failed.length === 0;

  let message: string;
  if (processed.length === 0 && failed.length === 0) {
    message = "No memberships found to process.";
  } else {
    const lines: string[] = [];
    if (processed.length > 0) {
      lines.push(`✅ Processed ${processed.length} membership(s):`);
      processed.forEach((p) => lines.push(`   - ${p.message}`));
    }
    if (failed.length > 0) {
      lines.push(`❌ Failed ${failed.length} membership(s):`);
      failed.forEach((f) => lines.push(`   - ${f.customer ?? "unknown"} | ${f.message}`));
    }
    message = lines.join("\n");
  }

  console.log(`\n📋 Summary:\n${message}\n⏱  ${elapsed} min`);

  return {
    success, message,
    processedCount: processed.length, failedCount: failed.length,
    processed, failed,
    elapsedMinutes: parseFloat(elapsed),
    sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok", service: "active-membership-server" });
});

app.post("/run-membership-fix", async (_req: Request, res: Response): Promise<void> => {
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-membership-fix`);
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: `Server error: ${msg}` });
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`\n🚀 Active Membership Server on port ${PORT}`);
  console.log(`   POST /run-membership-fix  ← n8n trigger`);
  console.log(`   GET  /health              ← Render health check\n`);
});
