// active-membership-server.ts
// Express server + Stagehand browser automation
//
// Modal has TWO variants depending on program type:
//   ┌─ Fixed-term plans (10-Year, 5-Year)
//   │    Starts On  +  Ends On
//   └─ Auto-Renew / recurring plans
//        Starts On  +  Next Billing Date
//
// Logic:
//   • Starts On      → always set to Sold On date
//   • Ends On        → Sold On + 10 or 5 years  (fixed-term only)
//   • Next Billing   → Sold On + 1 year          (auto-renew only)
//
// Deploy on Render, trigger via POST /run-membership-fix from n8n

import { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

// =============================================================================
// TYPES
// =============================================================================

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
  secondDateField: string;  // "endsOn" or "nextBillingDate" depending on modal
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

// Describes which second-date field a modal has
type ModalVariant = "ends-on" | "next-billing" | "unknown";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Determines which modal variant a program uses:
 *   "ends-on"      → 10-Year or 5-Year fixed plans  (has "Ends On" field)
 *   "next-billing" → Auto-Renew / recurring plans   (has "Next Billing Date" field)
 */
function getModalVariant(programName: string): ModalVariant {
  const name = programName.toLowerCase();
  if (name.includes("10-year") || name.includes("10 year")) return "ends-on";
  if (name.includes("5-year")  || name.includes("5 year"))  return "ends-on";
  return "next-billing";
}

/**
 * Calculates the second date value based on modal variant:
 *   ends-on      → soldOn + 10 or 5 years
 *   next-billing → soldOn + 1 year
 */
function calcSecondDate(soldOn: string, programName: string): string {
  const parts = soldOn.split("/");
  if (parts.length !== 3) return soldOn;

  const month = parts[0];
  const day   = parts[1];
  const year  = parseInt(parts[2], 10);

  const name = programName.toLowerCase();
  let yearsToAdd = 1; // default: auto-renew = +1 year

  if (name.includes("10-year") || name.includes("10 year")) yearsToAdd = 10;
  else if (name.includes("5-year") || name.includes("5 year")) yearsToAdd = 5;

  return `${month}/${day}/${year + yearsToAdd}`;
}

/**
 * After the modal opens, detects whether it has "Ends On" or "Next Billing Date"
 * by inspecting the live DOM — more reliable than guessing from program name alone.
 */
async function detectModalVariant(page: Page): Promise<ModalVariant> {
  const variant: ModalVariant = await page.evaluate((): ModalVariant => {
    const allText = document.body.innerText.toLowerCase();
    const hasEndsOn      = allText.includes("ends on");
    const hasNextBilling = allText.includes("next billing");

    if (hasEndsOn)      return "ends-on";
    if (hasNextBilling) return "next-billing";
    return "unknown";
  });
  return variant;
}

/**
 * Uses Stagehand act() to click and fill a date field in the open modal.
 */
async function fillDateField(page: Page, fieldLabel: string, dateValue: string): Promise<void> {
  await page.act(
    `In the open Edit Memberships modal, click the "${fieldLabel}" date input field, ` +
    `select all existing text in it, and replace it with the date ${dateValue}`
  );
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

    // ✅ Use stagehand.page — Stagehand's typed Page with .act() support
    //    Never use stagehand.context.pages()[0] — that's plain Playwright (no .act())
    const page: Page = stagehand.page;

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
    // STEP 3 — Read ALL rows first (before clicking anything)
    // ------------------------------------------------------------------
    console.log("\n[3] → Scanning membership table …");

    const allRows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const rows  = Array.from(document.querySelectorAll("table tbody tr"));
      const result: MembershipRow[] = [];

      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;

        const soldOn   = cells[0]?.textContent?.trim() ?? "";
        const invoice  = cells[1]?.textContent?.trim() ?? "";
        const job      = cells[2]?.textContent?.trim() ?? "";
        const customer = cells[3]?.textContent?.trim() ?? "";
        const program  = cells[4]?.textContent?.trim() ?? "";

        // Only process rows with a valid MM/DD/YYYY date
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
    // STEP 4 — Process each row: reload → click → detect modal → fill → save
    // ------------------------------------------------------------------
    for (let i = 0; i < allRows.length; i++) {
      const row            = allRows[i];
      const secondDate     = calcSecondDate(row.soldOn, row.program);
      const expectedVariant = getModalVariant(row.program);

      console.log(`\n[4.${i + 1}] ─────────────────────────────────────────────`);
      console.log(`  Customer        : ${row.customer}`);
      console.log(`  Program         : ${row.program}`);
      console.log(`  Sold On         : ${row.soldOn}`);
      console.log(`  Starts On (set) : ${row.soldOn}`);
      console.log(`  Expected modal  : ${expectedVariant === "ends-on" ? "Ends On" : "Next Billing Date"} → ${secondDate}`);

      // Reload page fresh for every row — prevents stale DOM / open modals
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(4000);

      // ----------------------------------------------------------------
      // 4a — Click the program link
      // ----------------------------------------------------------------
      console.log(`  → Clicking: "${row.program}"`);

      const clickResult: string = await page.evaluate((targetProgram: string): string => {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));

        // Exact match (case-insensitive)
        const exact = links.find(
          (el) =>
            el.textContent?.trim().toLowerCase() === targetProgram.toLowerCase() &&
            el.offsetParent !== null
        );
        if (exact) {
          exact.click();
          return `exact: "${exact.textContent?.trim()}"`;
        }

        // Partial match on first 12 chars
        const partial = links.find(
          (el) =>
            el.textContent?.trim().toLowerCase().startsWith(
              targetProgram.toLowerCase().substring(0, 12)
            ) &&
            el.offsetParent !== null &&
            !/^\d+$/.test(el.textContent?.trim() ?? "")
        );
        if (partial) {
          partial.click();
          return `partial: "${partial.textContent?.trim()}"`;
        }

        return "not found";
      }, row.program);

      console.log(`  ℹ️  Click result: ${clickResult}`);
      await page.waitForTimeout(3000);

      // ----------------------------------------------------------------
      // 4b — Confirm modal opened; fallback to act() if needed
      // ----------------------------------------------------------------
      let modalOpen: boolean = await page.evaluate((): boolean => {
        const el = document.querySelector<HTMLElement>(
          '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
        );
        return !!(el && el.offsetParent !== null);
      });

      if (!modalOpen) {
        console.log(`  ⚠️  Modal not detected — trying page.act() fallback …`);
        try {
          await page.act(
            `Click the program name link "${row.program}" in the memberships table ` +
            `to open the Edit Memberships modal`
          );
          await page.waitForTimeout(3000);
          modalOpen = await page.evaluate((): boolean => {
            const el = document.querySelector<HTMLElement>(
              '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
            );
            return !!(el && el.offsetParent !== null);
          });
        } catch (e: unknown) {
          console.log(`  ⚠️  page.act() fallback failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      if (!modalOpen) {
        failed.push({ ...row, message: `Modal never opened. Session: ${sessionUrl}` });
        console.log(`  ❌ Skipping row — modal did not open`);
        continue;
      }

      console.log(`  ✅ Modal is open`);

      // ----------------------------------------------------------------
      // 4c — Detect the actual modal variant from live DOM
      //       (more reliable than guessing from program name)
      // ----------------------------------------------------------------
      const actualVariant = await detectModalVariant(page);
      const variantToUse  = actualVariant !== "unknown" ? actualVariant : expectedVariant;
      const secondFieldLabel = variantToUse === "ends-on" ? "Ends On" : "Next Billing Date";

      console.log(`  ℹ️  Modal variant detected: "${secondFieldLabel}"`);

      // ----------------------------------------------------------------
      // 4d — Set "Starts On" = Sold On date
      // ----------------------------------------------------------------
      console.log(`  → Setting "Starts On" → ${row.soldOn}`);
      let startsOnSet = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fillDateField(page, "Starts On", row.soldOn);
          await page.waitForTimeout(1500);
          console.log(`  ✅ Starts On set (attempt ${attempt})`);
          startsOnSet = true;
          break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Starts On attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(1000);
        }
      }

      if (!startsOnSet) {
        console.log(`  ⚠️  Could not set Starts On — proceeding anyway`);
      }

      // ----------------------------------------------------------------
      // 4e — Set second date field ("Ends On" OR "Next Billing Date")
      // ----------------------------------------------------------------
      console.log(`  → Setting "${secondFieldLabel}" → ${secondDate}`);
      try {
        await fillDateField(page, secondFieldLabel, secondDate);
        await page.waitForTimeout(1500);
        console.log(`  ✅ "${secondFieldLabel}" set`);
      } catch (e: unknown) {
        console.log(`  ⚠️  "${secondFieldLabel}" error: ${e instanceof Error ? e.message : e}`);
      }

      // ----------------------------------------------------------------
      // 4f — Save & Complete
      // ----------------------------------------------------------------
      console.log(`  → Clicking "Save & Complete" …`);
      try {
        await page.act(`Click the "Save & Complete" button in the open Edit Memberships modal`);
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
  console.log(`⏱  Elapsed: ${elapsed} minutes`);

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
