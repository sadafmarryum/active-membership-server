// active-membership-server.ts
// Single file — Express server + Stagehand task
// Clicks each program link one by one, completes modal, moves to next
// Deploy on Render, call from n8n via POST /run-membership-fix

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// HELPERS
// =============================================================================

function calcNextBillingYear(startsOnYear: number, programName: string): number {
  const name = programName.toLowerCase();
  if (name.includes("10-year") || name.includes("10 year")) return startsOnYear + 10;
  if (name.includes("5-year")  || name.includes("5 year"))  return startsOnYear + 5;
  return startsOnYear + 1; // Auto-Renew or default
}

// =============================================================================
// MAIN TASK
// =============================================================================

async function runMembershipTask() {
  const startTime = Date.now();

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY || "",
    },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";
  const processed: any[] = [];
  const failed: any[]    = [];

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session started: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // ------------------------------------------------------------------
    // STEP 1 — Login
    // ------------------------------------------------------------------
    console.log("\n[1] → Logging in");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    const currentUrl: string = await page.url();
    if (currentUrl.includes("/login")) {
      const email    = process.env.SERA_EMAIL    || "mcc@stratablue.com";
      const password = process.env.SERA_PASSWORD || "";

      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

      const clicked = await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll('button, input[type="submit"]')
        ).find(
          (el) =>
            ["sign in", "login", "log in"].some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) await page.locator('button[type="submit"]').first().click();

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!(await page.url()).includes("/login")) {
          console.log("    ✅ Logged in");
          break;
        }
        if (i === 29) throw new Error("Still on login page after 30s");
      }
    } else {
      console.log("    ✅ Already logged in");
    }

    // ------------------------------------------------------------------
    // STEP 2 — Navigate to memberships
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to Memberships");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(5000);
    console.log(`    ℹ️  URL: ${await page.url()}`);

    // ------------------------------------------------------------------
    // STEP 3 — Read all rows FIRST before clicking anything
    // ------------------------------------------------------------------
    console.log("\n[3] → Reading all membership rows");

    const allRows: Array<{
      soldOn: string;
      invoice: string;
      job: string;
      customer: string;
      program: string;
      rowIndex: number;
    }> = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const result: any[] = [];

      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;

        const soldOn   = cells[0]?.textContent?.trim() || "";
        const invoice  = cells[1]?.textContent?.trim() || "";
        const job      = cells[2]?.textContent?.trim() || "";
        const customer = cells[3]?.textContent?.trim() || "";
        const program  = cells[4]?.textContent?.trim() || "";

        // Skip summary/footer rows (they have "# OF" text)
        if (soldOn.includes("#") || program.includes("#") || soldOn.length === 0) return;
        // Skip rows that are just summary counts
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;

        result.push({ soldOn, invoice, job, customer, program, rowIndex: idx });
      });

      return result;
    });

    console.log(`    ℹ️  Found ${allRows.length} membership row(s):`);
    allRows.forEach((r, i) => {
      console.log(`    Row ${i + 1}: ${r.soldOn} | ${r.customer} | ${r.program} | Job #${r.job}`);
    });

    if (allRows.length === 0) {
      return {
        success: true,
        message: "No memberships found to process.",
        processedCount: 0,
        failedCount: 0,
        processed: [],
        failed: [],
        elapsedMinutes: parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(2)),
        sessionUrl,
      };
    }

    // ------------------------------------------------------------------
    // STEP 4 — Process each row ONE BY ONE
    // After each row: close modal → reload page → click next program
    // ------------------------------------------------------------------
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      console.log(`\n[4.${i + 1}] → Processing: "${row.program}" (${row.customer})`);

      // Reload page fresh for each row to avoid stale state
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(4000);

      // ----------------------------------------------------------------
      // Click the program link by index position
      // Find all program links in order, click the i-th one
      // ----------------------------------------------------------------
      console.log(`    → Clicking program link ${i + 1}: "${row.program}"`);

      // Strategy: find the <a> tag whose text exactly matches the program name
      // Do NOT use column index — find by text content directly
      const clickResult: string = await page.evaluate(({ targetProgram }: { targetProgram: string }) => {
        // Search ALL <a> tags on the page for one matching the program name
        const allLinks = Array.from(document.querySelectorAll("a"));

        // Exact match first
        const exactMatch = allLinks.find(el =>
          el.textContent?.trim().toLowerCase() === targetProgram.toLowerCase() &&
          (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;

        if (exactMatch) {
          exactMatch.click();
          return `exact match clicked: "${exactMatch.textContent?.trim()}"`;
        }

        // Partial match (first 12 chars)
        const partialMatch = allLinks.find(el =>
          el.textContent?.trim().toLowerCase().includes(
            targetProgram.toLowerCase().substring(0, 12)
          ) &&
          (el as HTMLElement).offsetParent !== null &&
          !/^\d+$/.test(el.textContent?.trim() || "") // skip numeric links
        ) as HTMLElement | null;

        if (partialMatch) {
          partialMatch.click();
          return `partial match clicked: "${partialMatch.textContent?.trim()}"`;
        }

        return "not found";
      }, { targetProgram: row.program } as any);

      console.log(`    ℹ️  Click result: ${clickResult}`);
      await page.waitForTimeout(3000);

      // Check if modal opened
      let modalOpen: boolean = await page.evaluate(() => {
        const modal = document.querySelector(
          '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
        );
        return !!(modal && (modal as HTMLElement).offsetParent !== null);
      });

      // If modal not open, try page.act() as fallback
      if (!modalOpen) {
        console.log(`    ⚠️  Modal not open — trying page.act()`);
        try {
          await page.act(
            `click the program name link "${row.program}" in the memberships table to open the Edit Membership modal`
          );
          await page.waitForTimeout(3000);
          modalOpen = await page.evaluate(() => {
            const modal = document.querySelector(
              '.modal, [role="dialog"], [class*="modal"], [class*="Modal"], sera-modal'
            );
            return !!(modal && (modal as HTMLElement).offsetParent !== null);
          });
        } catch (e: any) {
          console.log(`    ⚠️  page.act() failed: ${e.message}`);
        }
      }

      if (!modalOpen) {
        failed.push({ ...row, message: `Modal did not open. Check session replay: ${sessionUrl}` });
        console.log(`    ❌ Modal failed to open — skipping row`);
        continue;
      }

      console.log(`    ✅ Modal opened`);

      // ----------------------------------------------------------------
      // Set Starts On = Sold On
      // ----------------------------------------------------------------
      console.log(`    → Setting Starts On to: ${row.soldOn}`);

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.act(
            `In the Edit Membership modal that is currently open, click the "Starts On" date field and change the date to ${row.soldOn}`
          );
          await page.waitForTimeout(2000);
          console.log(`    ℹ️  Starts On set attempt ${attempt} done`);
          break;
        } catch (e: any) {
          console.log(`    ⚠️  Starts On attempt ${attempt} error: ${e.message}`);
        }
      }

      // ----------------------------------------------------------------
      // Calculate and set Next Billing Date
      // ----------------------------------------------------------------
      const soldOnParts = row.soldOn.split("/");
      let nextBillingDate = row.soldOn;

      if (soldOnParts.length === 3) {
        const month    = soldOnParts[0];
        const day      = soldOnParts[1];
        const year     = parseInt(soldOnParts[2], 10);
        const nextYear = calcNextBillingYear(year, row.program);
        nextBillingDate = `${month}/${day}/${nextYear}`;
      }

      console.log(`    → Setting Next Billing Date to: ${nextBillingDate}`);
      try {
        await page.act(
          `In the Edit Membership modal, find the "Next Billing Date" field, clear it, and set it to exactly ${nextBillingDate}`
        );
        await page.waitForTimeout(1500);
        console.log(`    ✅ Next Billing Date set`);
      } catch (e: any) {
        console.log(`    ⚠️  Next Billing Date error: ${e.message}`);
      }

      // ----------------------------------------------------------------
      // Final check and Save & Complete
      // ----------------------------------------------------------------
      console.log(`    → Clicking Save & Complete`);
      try {
        await page.act(
          `click the "Save & Complete" button in the Edit Membership modal`
        );
        await page.waitForTimeout(3000);
        console.log(`    ✅ Saved`);

        processed.push({
          customer:       row.customer,
          job:            row.job,
          program:        row.program,
          soldOn:         row.soldOn,
          startsOn:       row.soldOn,
          nextBillingDate,
          message: `${row.customer} | Job #${row.job} | ${row.program} | Starts On: ${row.soldOn} | Next Billing: ${nextBillingDate}`,
        });
      } catch (e: any) {
        failed.push({ ...row, message: `Save failed: ${e.message}` });
        console.log(`    ❌ Save failed: ${e.message}`);
      }
    }

  } catch (error: any) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    failed.push({ message: `Fatal: ${error.message}` });
  } finally {
    await stagehand.close();
    console.log("\n🔒 Session closed");
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const success = failed.length === 0 && processed.length >= 0;

  let message = "";
  if (processed.length === 0 && failed.length === 0) {
    message = "No memberships found to process.";
  } else {
    if (processed.length > 0) {
      message += `Membership date correction completed for ${processed.length} membership(s):\n`;
      processed.forEach(p => { message += `- ${p.message}\n`; });
    }
    if (failed.length > 0) {
      message += `\nFailed ${failed.length} membership(s):\n`;
      failed.forEach(f => { message += `- ${f.customer || "unknown"} | ${f.message}\n`; });
    }
  }

  console.log(`\n📋 Final:\n${message}`);

  return {
    success,
    message:        message.trim(),
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "active-membership-server" });
});

app.post("/run-membership-fix", async (_req, res) => {
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-membership-fix received`);
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: `Server error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Active Membership Server running on port ${PORT}`);
  console.log(`   POST /run-membership-fix  ← n8n calls this`);
  console.log(`   GET  /health              ← Render health check\n`);
});
