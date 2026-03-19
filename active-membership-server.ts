// active-membership-server.ts
// Express server + Stagehand v3 browser automation
//
// ╔══════════════════════════════════════════════════════════════════╗
// ║  ROOT CAUSE OF PREVIOUS ERRORS                                  ║
// ║                                                                  ║
// ║  stagehand.act() asks Gemini to find an element by returning    ║
// ║  an elementId. When Gemini can't find the element (e.g. a       ║
// ║  button inside a modal/shadow-DOM), it returns elementId: ""    ║
// ║  which fails Stagehand's Zod schema → AI_NoObjectGeneratedError ║
// ║                                                                  ║
// ║  FIX: Use page.locator(selector).click() / .fill() for ALL      ║
// ║  interactions — pure CDP, zero AI calls, zero schema failures.  ║
// ║  stagehand.act() is NOT used anywhere in this file.             ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// Modal has TWO variants depending on program type:
//   ┌─ Fixed-term plans (10-Year, 5-Year)
//   │    Starts On  +  Ends On
//   └─ Auto-Renew / recurring plans
//        Starts On  +  Next Billing Date
//
// Logic:
//   • Starts On         → always set to Sold On date
//   • Ends On           → Sold On + 10 or 5 years  (fixed-term only)
//   • Next Billing Date → Sold On + 1 year          (auto-renew only)

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

// =============================================================================
// TYPES
// =============================================================================

type SPage       = NonNullable<ReturnType<V3["context"]["activePage"]>>;
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
// HELPERS
// =============================================================================

function calcSecondDate(soldOn: string, programName: string): string {
  const parts = soldOn.split("/");
  if (parts.length !== 3) return soldOn;
  const month = parts[0];
  const day   = parts[1];
  const year  = parseInt(parts[2], 10);
  const n     = programName.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  return `${month}/${day}/${year + add}`;
}

function getModalVariant(programName: string): ModalVariant {
  const n = programName.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

/** Read the open modal DOM to confirm which second-date field is present. */
async function detectModalVariant(page: SPage): Promise<ModalVariant> {
  return page.evaluate((): ModalVariant => {
    const t = document.body.innerText.toLowerCase();
    if (t.includes("ends on"))      return "ends-on";
    if (t.includes("next billing")) return "next-billing";
    return "unknown";
  });
}

/**
 * Fill a date input identified by its visible label.
 * Strategy:
 *   1) Find the <label> whose text matches labelText
 *   2) Use its `for` attribute (or closest input sibling) to find the input
 *   3) Triple-click to select all, then type the new date
 * Falls back to searching by placeholder/aria-label if no <label> found.
 * Pure CDP — no AI involved.
 */
async function fillDateByLabel(
  page: SPage,
  labelText: string,
  dateValue: string
): Promise<void> {
  // Find the input linked to the label via DOM evaluation, then fill it
  const selector: string = await page.evaluate((lbl: string): string => {
    // Find label by text content (case-insensitive)
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>("label"));
    const label  = labels.find(
      (el) => el.textContent?.trim().toLowerCase() === lbl.toLowerCase()
    );

    if (label) {
      const forId = label.getAttribute("for");
      if (forId) return `#${forId}`;
      // Input may be a sibling or child
      const sibling = label.nextElementSibling as HTMLElement | null;
      if (sibling?.tagName === "INPUT") {
        sibling.id = sibling.id || `__sh_${Math.random().toString(36).slice(2)}`;
        return `#${sibling.id}`;
      }
      const child = label.querySelector<HTMLInputElement>("input");
      if (child) {
        child.id = child.id || `__sh_${Math.random().toString(36).slice(2)}`;
        return `#${child.id}`;
      }
    }

    // Fallback: look for input whose preceding label text matches
    const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='text'], input[type='date'], input:not([type])"));
    for (const inp of allInputs) {
      // Check aria-label
      if (inp.getAttribute("aria-label")?.toLowerCase() === lbl.toLowerCase()) {
        inp.id = inp.id || `__sh_${Math.random().toString(36).slice(2)}`;
        return `#${inp.id}`;
      }
      // Check placeholder
      if (inp.placeholder?.toLowerCase().includes(lbl.toLowerCase())) {
        inp.id = inp.id || `__sh_${Math.random().toString(36).slice(2)}`;
        return `#${inp.id}`;
      }
    }

    return "";
  }, labelText);

  if (!selector) {
    throw new Error(`Could not find input for label "${labelText}"`);
  }

  const locator = page.locator(selector).first();

  // Triple-click selects all existing text, then type new value
  await locator.click({ clickCount: 3 });
  await page.waitForTimeout(200);
  await locator.fill(dateValue);
  await page.waitForTimeout(300);
}

/**
 * Click the "Save & Complete" button using a direct CDP locator.
 * Tries multiple selectors in order of specificity.
 * Pure CDP — no AI involved.
 */
async function clickSaveAndComplete(page: SPage): Promise<void> {
  // Build a prioritised list of selectors for the Save & Complete button
  const selectors = [
    "button:has-text('Save & Complete')",
    "button:has-text('Save and Complete')",
    // Generic: any visible button whose text is exactly "Save & Complete"
    // (resolved via evaluate to get a stable ID, then click by ID)
  ];

  // Try CSS/text-based locators first
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await loc.click();
        return;
      }
    } catch {
      // try next
    }
  }

  // Fallback: find button by text via evaluate, assign a stable ID, then click
  const btnId: string = await page.evaluate((): string => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, input[type='submit'], [role='button']"));
    const btn = buttons.find((el) => {
      const txt = el.textContent?.trim().toLowerCase() ?? "";
      return txt === "save & complete" || txt === "save and complete";
    });
    if (!btn) return "";
    const id = `__save_btn_${Math.random().toString(36).slice(2)}`;
    btn.id = id;
    return id;
  });

  if (!btnId) {
    throw new Error("Save & Complete button not found in DOM");
  }

  await page.locator(`#${btnId}`).first().click();
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
    console.log(`✅ Session started: ${sessionUrl}`);

    const page: SPage = stagehand.context.activePage()!;

    // ------------------------------------------------------------------
    // STEP 1 — Login
    // ------------------------------------------------------------------
    console.log("\n[1] → Logging in …");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      const email    = process.env.SERA_EMAIL    ?? "mcc@stratablue.com";
      const password = process.env.SERA_PASSWORD ?? "";

      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

      // Click the login submit button directly
      const clicked: boolean = await page.evaluate((): boolean => {
        const keywords = ["sign in", "login", "log in"];
        const btn = Array.from(
          document.querySelectorAll<HTMLElement>('button, input[type="submit"]')
        ).find(
          (el) =>
            keywords.some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && el.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!clicked) {
        await page.locator('button[type="submit"]').first().click();
      }

      let loggedIn = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes("/login")) { loggedIn = true; break; }
      }
      if (!loggedIn) throw new Error("Still on login page after 30s — check credentials");
      console.log("    ✅ Logged in");
    } else {
      console.log("    ✅ Already logged in");
    }

    // ------------------------------------------------------------------
    // STEP 2 — Navigate to Memberships
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to /memberships …");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(5000);
    console.log(`    ℹ️  URL: ${page.url()}`);

    // ------------------------------------------------------------------
    // STEP 3 — Read ALL rows before touching anything
    // ------------------------------------------------------------------
    console.log("\n[3] → Scanning membership table …");

    const allRows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
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

    console.log(`    ℹ️  Found ${allRows.length} row(s):`);
    allRows.forEach((r, i) =>
      console.log(`      [${i + 1}] ${r.soldOn} | ${r.customer} | ${r.program} | Job #${r.job}`)
    );

    if (allRows.length === 0) {
      return {
        success: true,
        message: "No membership rows found — nothing to process.",
        processedCount: 0,
        failedCount: 0,
        processed: [],
        failed: [],
        elapsedMinutes: parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(2)),
        sessionUrl,
      };
    }

    // ------------------------------------------------------------------
    // STEP 4 — Process each row
    // ------------------------------------------------------------------
    for (let i = 0; i < allRows.length; i++) {
      const row             = allRows[i];
      const secondDate      = calcSecondDate(row.soldOn, row.program);
      const expectedVariant = getModalVariant(row.program);

      console.log(`\n[4.${i + 1}] ─────────────────────────────────────────────`);
      console.log(`  Customer : ${row.customer}`);
      console.log(`  Program  : ${row.program}`);
      console.log(`  Sold On  : ${row.soldOn}`);
      console.log(`  Expected : ${expectedVariant === "ends-on" ? "Ends On" : "Next Billing Date"} → ${secondDate}`);

      // Fresh reload for every row
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(4000);

      // ----------------------------------------------------------------
      // 4a — Click the program link via DOM (no AI)
      // ----------------------------------------------------------------
      console.log(`  → Clicking: "${row.program}"`);

      const clickResult: string = await page.evaluate((target: string): string => {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
        const exact = links.find(
          (el) =>
            el.textContent?.trim().toLowerCase() === target.toLowerCase() &&
            el.offsetParent !== null
        );
        if (exact) { exact.click(); return `exact: "${exact.textContent?.trim()}"`; }

        const partial = links.find(
          (el) =>
            el.textContent?.trim().toLowerCase().startsWith(target.toLowerCase().substring(0, 12)) &&
            el.offsetParent !== null &&
            !/^\d+$/.test(el.textContent?.trim() ?? "")
        );
        if (partial) { partial.click(); return `partial: "${partial.textContent?.trim()}"`; }

        return "not found";
      }, row.program);

      console.log(`  ℹ️  Click result: ${clickResult}`);
      await page.waitForTimeout(3000);

      // ----------------------------------------------------------------
      // 4b — Confirm modal opened
      // ----------------------------------------------------------------
      let modalOpen: boolean = await page.evaluate((): boolean => {
        const el = document.querySelector<HTMLElement>(
          '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
        );
        return !!(el && el.offsetParent !== null);
      });

      if (!modalOpen) {
        // Fallback: try clicking by button/link text via evaluate
        console.log(`  ⚠️  Modal not detected — trying evaluate fallback …`);
        await page.evaluate((target: string): void => {
          const all = Array.from(document.querySelectorAll<HTMLElement>("a, button, td, span"));
          const el = all.find(
            (e) => e.textContent?.trim().toLowerCase().includes(target.toLowerCase().substring(0, 10)) &&
                   e.offsetParent !== null
          );
          if (el) el.click();
        }, row.program);
        await page.waitForTimeout(3000);

        modalOpen = await page.evaluate((): boolean => {
          const el = document.querySelector<HTMLElement>(
            '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
          );
          return !!(el && el.offsetParent !== null);
        });
      }

      if (!modalOpen) {
        failed.push({ ...row, message: `Modal never opened. Session: ${sessionUrl}` });
        console.log(`  ❌ Skipping row — modal did not open`);
        continue;
      }

      console.log(`  ✅ Modal is open`);

      // ----------------------------------------------------------------
      // 4c — Detect actual variant from live DOM
      // ----------------------------------------------------------------
      const actualVariant    = await detectModalVariant(page);
      const variantToUse     = actualVariant !== "unknown" ? actualVariant : expectedVariant;
      const secondFieldLabel = variantToUse === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log(`  ℹ️  Modal variant: "${secondFieldLabel}"`);

      // ----------------------------------------------------------------
      // 4d — Set "Starts On" = Sold On (pure CDP fill, no AI)
      // ----------------------------------------------------------------
      console.log(`  → Setting "Starts On" → ${row.soldOn}`);
      let startsOnSet = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fillDateByLabel(page, "Starts On", row.soldOn);
          await page.waitForTimeout(1000);
          console.log(`  ✅ Starts On set (attempt ${attempt})`);
          startsOnSet = true;
          break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Starts On attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(800);
        }
      }

      if (!startsOnSet) console.log(`  ⚠️  Could not set Starts On — proceeding anyway`);

      // ----------------------------------------------------------------
      // 4e — Set "Ends On" or "Next Billing Date" (pure CDP fill, no AI)
      // ----------------------------------------------------------------
      console.log(`  → Setting "${secondFieldLabel}" → ${secondDate}`);
      try {
        await fillDateByLabel(page, secondFieldLabel, secondDate);
        await page.waitForTimeout(1000);
        console.log(`  ✅ "${secondFieldLabel}" set`);
      } catch (e: unknown) {
        console.log(`  ⚠️  "${secondFieldLabel}" error: ${e instanceof Error ? e.message : e}`);
      }

      // ----------------------------------------------------------------
      // 4f — Click "Save & Complete" (pure CDP click, no AI)
      // ----------------------------------------------------------------
      console.log(`  → Clicking "Save & Complete" …`);
      try {
        await clickSaveAndComplete(page);
        await page.waitForTimeout(3000);
        console.log(`  ✅ Saved`);

        processed.push({
          customer:        row.customer,
          job:             row.job,
          program:         row.program,
          soldOn:          row.soldOn,
          startsOn:        row.soldOn,
          secondDateField: secondFieldLabel,
          secondDateValue: secondDate,
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
    console.error(`\n❌ Fatal error: ${msg}`);
    failed.push({ message: `Fatal: ${msg}` });
  } finally {
    await stagehand.close();
    console.log("\n🔒 Browser session closed");
  }

  // ------------------------------------------------------------------
  // Build final response
  // ------------------------------------------------------------------
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
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

  console.log(`\n📋 Summary:\n${message}`);
  console.log(`⏱  Elapsed: ${elapsed} min`);

  return {
    success,
    message,
    processedCount: processed.length,
    failedCount:    failed.length,
    processed,
    failed,
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
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-membership-fix received`);
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
  console.log(`\n🚀 Active Membership Server running on port ${PORT}`);
  console.log(`   POST /run-membership-fix  ← n8n trigger`);
  console.log(`   GET  /health              ← Render health check\n`);
});
