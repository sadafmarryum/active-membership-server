// active-membership-server.ts
// Single file — Express server + Stagehand AI agent task
// Deploy on Render, call from n8n Schedule Trigger via POST /run-membership-fix

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// PROMPT — exact task instructions for the AI agent
// =============================================================================

const MEMBERSHIP_PROMPT = `
GENERAL RULES (CRITICAL - STRICT ENFORCEMENT):
- Never retry the same action more than 3 times.
- If Sold On date and Starts On date do NOT match exactly, DO NOT save.
- If equality cannot be achieved after retries, STOP execution and report failure.
- Always wait for modals or page loads to fully appear before interacting.
- Verify success after every major step.
- Do NOT rely on vertical scrolling to reveal hidden content.

DATE SYNCHRONIZATION RULE (HIGHEST PRIORITY):
- The Sold On table date is the SINGLE SOURCE OF TRUTH.
- Inside the Edit Membership modal, the Starts On date MUST be EXACTLY equal to Sold On.
- Month, day, and year must match character-for-character.
- If the modal auto-adjusts the date, overwrite it.
- Saving is FORBIDDEN unless both dates are identical.

DATE PICKER INTERACTION RULES:
- Always use the calendar/date-picker widget.
- Clear the date field before selecting a new value.
- Select the exact Sold On date.
- After selection, visually re-read the field.
- Compare Starts On vs Sold On before continuing.

IMPORTANT: You are already logged in and already on the Memberships To-Do page at
https://misterquik.sera.tech/memberships
DO NOT navigate to login. DO NOT click Dispatch. Start directly from Step 3 below.

STEP 3: Process Memberships With Pagination Loop
REPEAT for all pages:

A. For EACH membership row:
1. Read and store the Sold On date from the table
2. Click the Program name to open Edit Membership modal
3. WAIT until modal is fully visible
4. SUCCESS CHECK: Modal is open

STARTS ON ENFORCEMENT LOOP:
5. Click Starts On field
6. Clear existing value
7. Use date picker to select the EXACT Sold On date
8. Re-read the Starts On value
9. IF Starts On is not equal to Sold On:
   - Repeat steps 5 to 8 (maximum 3 attempts)
10. IF still not equal after 3 attempts:
   - STOP execution and report mismatch error

NEXT BILLING DATE:
11. Calculate from Starts On:
   - Month and day MUST be exactly the same as Starts On
   - Year = Starts On year + 1/5/10 according to program:
       - If program contains "10-Year" add 10 years
       - If program contains "5-Year" add 5 years
       - If program contains "Auto-Renew" add 1 year
12. Set using the date picker
13. Verify displayed value matches expected month/day/year

FINAL VALIDATION BEFORE SAVE:
14. Confirm Starts On EXACTLY equals Sold On
15. Confirm Next Billing Date matches expected month/day/year
16. Ensure no validation errors are visible
17. Click "Save & Complete"
18. WAIT until modal closes
19. SUCCESS CHECK: Membership saved

B. Pagination:
1. If next page exists go to next
2. Otherwise exit loop

STEP 4: Final Report
Output: "Membership date correction completed for all available memberships. For each processed membership, include the Customer Name and Job Number in the final message."

STOP EXECUTION.
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
    // STEP 2 — Navigate DIRECTLY to memberships page
    // Do not rely on sidebar — go straight to the URL
    // ------------------------------------------------------------------
    console.log("\n[2] → Navigating directly to Memberships page");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(5000);

    // Confirm page loaded correctly
    const pageUrl: string = await page.url();
    console.log(`    ℹ️  Current URL: ${pageUrl}`);

    const pageText: string = await page.evaluate(() => {
      return document.body.textContent?.substring(0, 200) || "";
    });
    console.log(`    ℹ️  Page content preview: ${pageText.replace(/\s+/g, " ").trim()}`);

    // Wait for table to appear
    try {
      await waitUntilVisible(page, "table, tbody, .memberships-table, [class*='membership']", 15000);
      console.log("    ✅ Memberships table is visible");
    } catch {
      console.log("    ⚠️  Table not found via selector — agent will handle it visually");
    }

    // ------------------------------------------------------------------
    // STEP 3 — Hand off to AI agent for complex membership work
    // Agent starts from the already-loaded memberships page
    // ------------------------------------------------------------------
    console.log("\n[3] → Starting AI agent for membership processing");
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
