// active-membership-server.ts
// Single file — Express server + Stagehand AI agent task
// Deploy on Render, call from n8n Schedule Trigger via POST /run-membership-fix

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// PROMPT — exact task instructions for the AI agent
// =============================================================================

const MEMBERSHIP_PROMPT = `
IMPORTANT CONTEXT:
- You are already logged in and already on the Memberships To-Do page.
- The page URL is: https://misterquik.sera.tech/memberships
- The page title is "Memberships To-Do"
- The table has these columns: SOLD ON | INVOICE | JOB | CUSTOMER | PROGRAM | SYSTEMS | DEPARTMENT | OWNER | COMPLETE
- To open the Edit Membership modal: click the PROGRAM name link (e.g. "10-Year Shape Plan") in the PROGRAM column.
- Do NOT click Invoice number or Job number — only click the PROGRAM name.
- Do NOT navigate anywhere. Do NOT login. Start processing immediately.

GENERAL RULES:
- Never retry the same action more than 3 times.
- If Sold On date and Starts On date do NOT match exactly after 3 retries, DO NOT save — report failure.
- Always wait for modals or page loads to fully appear before interacting.
- Verify success after every major step.

DATE SYNCHRONIZATION RULE (HIGHEST PRIORITY):
- The Sold On date shown in the table row is the SINGLE SOURCE OF TRUTH.
- Inside the Edit Membership modal, the Starts On date MUST be EXACTLY equal to the Sold On date.
- Month, day, and year must match character-for-character.
- If the modal auto-adjusts the date, overwrite it with the correct Sold On date.
- Saving is FORBIDDEN unless Starts On exactly equals Sold On.

DATE PICKER RULES:
- Always use the calendar/date-picker widget to set dates.
- Clear the date field before selecting a new value.
- After selection, re-read the field value to confirm it matches.

NEXT BILLING DATE CALCULATION:
- Month and day must be exactly the same as Starts On.
- Year is calculated based on the program name:
    - If program contains "10-Year" → add 10 years to Starts On year
    - If program contains "5-Year"  → add 5 years to Starts On year
    - If program contains "Auto-Renew" → add 1 year to Starts On year

PROCESSING STEPS — repeat for EVERY row in the table:

1. Read the Sold On date from the current row (e.g. "03/19/2026")
2. Read the Program name from the PROGRAM column (e.g. "10-Year Shape Plan")
3. Read the Customer name from the CUSTOMER column
4. Read the Job number from the JOB column
5. Click the PROGRAM name link to open the Edit Membership modal
6. Wait for the Edit Membership modal to fully open
7. In the modal:
   a. Find the "Starts On" date field
   b. Clear it and set it to exactly the Sold On date from step 1
   c. Re-read the Starts On field to confirm it matches Sold On exactly
   d. If it does not match, retry up to 3 times — if still wrong, stop and report error
   e. Calculate the Next Billing Date: same month and day as Starts On, year + offset based on program
   f. Set the Next Billing Date using the date picker
   g. Confirm Next Billing Date is correct
   h. Confirm Starts On still equals Sold On
   i. Confirm no validation errors are visible
   j. Click "Save & Complete"
   k. Wait for the modal to close
   l. Confirm the row is now marked as complete

PAGINATION:
- After processing all rows on the current page, check if a next page button exists.
- If yes, click next page and repeat the processing steps.
- If no, stop.

FINAL REPORT:
When all memberships are processed, output a summary that includes:
- Total memberships processed
- For each membership: Customer Name, Job Number, Program, Starts On date set, Next Billing Date set
- Example: "Processed 1 membership: Chuck Dotson | Job #8943860 | 10-Year Shape Plan | Starts On: 03/19/2026 | Next Billing: 03/19/2036"

STOP EXECUTION after the final report.
`.trim();

// =============================================================================
// HELPERS
// =============================================================================

async function waitUntilVisible(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (visible) return true;
    } catch { /* not ready */ }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout (${timeoutMs}ms): "${selector}" never became visible`);
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
  let agentResult: any = null;

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
      if (!clicked) {
        await page.locator('button[type="submit"]').first().click();
      }

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const url: string = await page.url();
        if (!url.includes("/login")) {
          console.log(`    ✅ Logged in — redirected to: ${url}`);
          break;
        }
        if (i === 29) throw new Error("Still on login page after 30s — check credentials");
      }
    } else {
      console.log("    ✅ Already logged in");
    }

    // ------------------------------------------------------------------
    // STEP 2 — Navigate directly to memberships page
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating to Memberships page");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(5000);

    const pageUrl: string = await page.url();
    console.log(`    ℹ️  Current URL: ${pageUrl}`);

    // Wait for table to load
    try {
      await waitUntilVisible(page, "table tbody tr, .memberships-table tr", 15000);
      console.log("    ✅ Memberships table loaded");
    } catch {
      console.log("    ⚠️  Table selector not found — agent will handle visually");
    }

    // Log what rows are visible so we can confirm page loaded
    const rowData: string[] = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(r => r.textContent?.replace(/\s+/g, " ").trim() || "").filter(t => t.length > 0);
    });
    console.log(`    ℹ️  Found ${rowData.length} row(s) in table`);
    rowData.forEach((r, i) => console.log(`    Row ${i + 1}: ${r.substring(0, 100)}`));

    // ------------------------------------------------------------------
    // STEP 3 — Click the first program link via DOM to confirm it works
    // then let agent handle the modal and all subsequent rows
    // ------------------------------------------------------------------
    console.log("\n[3] → Clicking first Program link to open Edit Membership modal");

    // Find and click the program link directly — from screenshot it's a blue link in PROGRAM column
    const programClicked = await page.evaluate(() => {
      // The program name is a link — find it in the table
      // From screenshot: "10-Year Shape Plan" is a clickable link
      const links = Array.from(document.querySelectorAll("table tbody tr td a, table tbody tr td button"));
      // Skip invoice and job number links (they are numeric) — find the text link
      const programLink = links.find(el => {
        const text = el.textContent?.trim() || "";
        // Program names contain words like "Year", "Plan", "Auto", "Shape", "Renew"
        return text.length > 5 && !/^\d+$/.test(text) && !text.includes("@");
      }) as HTMLElement | null;
      if (programLink) {
        const text = programLink.textContent?.trim();
        programLink.click();
        return text;
      }
      return null;
    });

    if (programClicked) {
      console.log(`    ✅ Clicked program: "${programClicked}"`);
      await page.waitForTimeout(3000);

      // Check if modal opened
      const modalVisible = await page.evaluate(() => {
        const modal = document.querySelector('.modal, [role="dialog"], .modal-content, [class*="modal"]');
        return modal !== null && (modal as HTMLElement).offsetParent !== null;
      });
      console.log(`    ℹ️  Modal visible: ${modalVisible}`);

      if (modalVisible) {
        console.log("    ✅ Modal opened successfully — handing off to AI agent");
      } else {
        console.log("    ⚠️  Modal did not open via DOM click — agent will retry visually");
      }
    } else {
      console.log("    ⚠️  Program link not found via DOM — agent will handle from scratch");
    }

    // ------------------------------------------------------------------
    // STEP 4 — Hand off to AI agent
    // ------------------------------------------------------------------
    console.log("\n[4] → Starting AI agent");
    console.log(`    🔍 Watch live: ${sessionUrl}`);

    const agent = stagehand.agent({
      model: {
        modelName: "google/gemini-2.5-flash",
        apiKey: process.env.GEMINI_API_KEY || "",
      },
    });

    agentResult = await agent.execute({
      instruction: MEMBERSHIP_PROMPT,
      maxSteps: 200,
    });

    console.log(`\n✅ Agent completed`);
    console.log(`   Success: ${agentResult?.success}`);
    console.log(`   Message: ${agentResult?.message}`);

  } catch (error: any) {
    console.error(`\n❌ Task error: ${error.message}`);
    agentResult = {
      success: false,
      message: `Task failed: ${error.message}. Session: ${sessionUrl}`,
    };
  } finally {
    await stagehand.close();
    console.log("\n🔒 Browser session closed");
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

  return {
    success:        agentResult?.success  ?? false,
    message:        agentResult?.message  ?? "Task did not complete — check session replay.",
    actions:        agentResult?.actions?.length ?? 0,
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
