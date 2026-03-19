// active-membership-server.ts
// Express server + Stagehand v3 browser automation
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  STAGEHAND v3 API — key differences from v2                 ║
// ║  ✅  stagehand.act(...)         ← AI actions on V3 instance ║
// ║  ✅  stagehand.context          ← CDP-backed V3Context      ║
// ║  ✅  stagehand.context          ║
// ║       .activePage()!            ← get the live Page         ║
// ║  ❌  stagehand.page             ← does NOT exist in v3      ║
// ║  ❌  page.act(...)              ← does NOT exist on Page    ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Modal has TWO variants depending on program type:
//   ┌─ Fixed-term plans (10-Year, 5-Year)
//   │    Starts On  +  Ends On
//   └─ Auto-Renew / recurring plans
//        Starts On  +  Next Billing Date
//
// Logic:
//   • Starts On        → always set to Sold On date
//   • Ends On          → Sold On + 10 or 5 years  (fixed-term only)
//   • Next Billing Date→ Sold On + 1 year          (auto-renew only)
//
// Deploy on Render, trigger via POST /run-membership-fix from n8n

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

// =============================================================================
// TYPES
// =============================================================================

// Derive the Page type directly from V3's context — it is not a public export
type SPage = NonNullable<ReturnType<V3["context"]["activePage"]>>;

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
  secondDateField: string; // "Ends On" or "Next Billing Date"
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

/**
 * Guesses which modal variant a program uses from its name:
 *   "ends-on"      → 10-Year or 5-Year fixed plans
 *   "next-billing" → Auto-Renew / recurring plans
 * detectModalVariant() below confirms this against the live DOM after opening.
 */
function getModalVariant(programName: string): ModalVariant {
  const n = programName.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

/**
 * Calculates the second date:
 *   10-year plans → soldOn + 10 years
 *   5-year plans  → soldOn + 5 years
 *   everything else (auto-renew) → soldOn + 1 year
 */
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

/**
 * Reads the live DOM after the modal opens to confirm which second-date
 * field is present — more reliable than guessing from program name alone.
 */
async function detectModalVariant(page: SPage): Promise<ModalVariant> {
  return page.evaluate((): ModalVariant => {
    const t = document.body.innerText.toLowerCase();
    if (t.includes("ends on"))      return "ends-on";
    if (t.includes("next billing")) return "next-billing";
    return "unknown";
  });
}

/**
 * Asks Stagehand's AI to click and fill a date field in the open modal.
 * act() lives on the V3 (stagehand) instance — NOT on the page object.
 */
async function fillDateField(
  stagehand: V3,
  fieldLabel: string,
  dateValue: string
): Promise<void> {
  await stagehand.act(
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

    // In v3 the page lives in stagehand.context — activePage() returns the
    // current top-level page. We use it for all DOM/navigation operations.
    // AI actions (act) are called on stagehand directly.
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
    // STEP 3 — Read ALL rows before clicking anything
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
    // STEP 4 — Process each row: reload → click → detect modal → fill → save
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

      // Fresh reload for every row — no stale modals or DOM state
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(4000);

      // ----------------------------------------------------------------
      // 4a — Click the program link via DOM (fast, no AI token cost)
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
      // 4b — Confirm modal opened; fallback to stagehand.act() if needed
      // ----------------------------------------------------------------
      let modalOpen: boolean = await page.evaluate((): boolean => {
        const el = document.querySelector<HTMLElement>(
          '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
        );
        return !!(el && el.offsetParent !== null);
      });

      if (!modalOpen) {
        console.log(`  ⚠️  Modal not detected — trying stagehand.act() fallback …`);
        try {
          // act() is on the stagehand (V3) instance, not on page
          await stagehand.act(
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
          console.log(`  ⚠️  stagehand.act() fallback failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      if (!modalOpen) {
        failed.push({ ...row, message: `Modal never opened. Session: ${sessionUrl}` });
        console.log(`  ❌ Skipping row — modal did not open`);
        continue;
      }

      console.log(`  ✅ Modal is open`);

      // ----------------------------------------------------------------
      // 4c — Detect actual modal variant from live DOM
      // ----------------------------------------------------------------
      const actualVariant    = await detectModalVariant(page);
      const variantToUse     = actualVariant !== "unknown" ? actualVariant : expectedVariant;
      const secondFieldLabel = variantToUse === "ends-on" ? "Ends On" : "Next Billing Date";

      console.log(`  ℹ️  Modal variant: "${secondFieldLabel}"`);

      // ----------------------------------------------------------------
      // 4d — Set "Starts On" = Sold On date
      // ----------------------------------------------------------------
      console.log(`  → Setting "Starts On" → ${row.soldOn}`);
      let startsOnSet = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fillDateField(stagehand, "Starts On", row.soldOn);
          await page.waitForTimeout(1500);
          console.log(`  ✅ Starts On set (attempt ${attempt})`);
          startsOnSet = true;
          break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Starts On attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(1000);
        }
      }

      if (!startsOnSet) console.log(`  ⚠️  Could not set Starts On — proceeding anyway`);

      // ----------------------------------------------------------------
      // 4e — Set "Ends On" or "Next Billing Date"
      // ----------------------------------------------------------------
      console.log(`  → Setting "${secondFieldLabel}" → ${secondDate}`);
      try {
        await fillDateField(stagehand, secondFieldLabel, secondDate);
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
        await stagehand.act(`Click the "Save & Complete" button in the open Edit Memberships modal`);
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
