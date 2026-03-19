// active-membership-server.ts

import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

// =============================================================================
// HELPERS
// =============================================================================

function calcNextBillingYear(startsOnYear: number, programName: string): number {
  const name = programName.toLowerCase();
  if (name.includes("10-year") || name.includes("10 year")) return startsOnYear + 10;
  if (name.includes("5-year")  || name.includes("5 year"))  return startsOnYear + 5;
  return startsOnYear + 1;
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

    // LOGIN
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if ((await page.url()).includes("/login")) {
      await page.locator('input[type="email"]').first().fill(process.env.SERA_EMAIL || "");
      await page.locator('input[type="password"]').first().fill(process.env.SERA_PASSWORD || "");
      await page.locator('button[type="submit"]').first().click();

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!(await page.url()).includes("/login")) break;
      }
    }

    // NAVIGATION
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(5000);

    // READ ROWS
    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map((row, idx) => {
        const cells = row.querySelectorAll("td");
        return {
          soldOn: cells[0]?.textContent?.trim() || "",
          invoice: cells[1]?.textContent?.trim() || "",
          job: cells[2]?.textContent?.trim() || "",
          customer: cells[3]?.textContent?.trim() || "",
          program: cells[4]?.textContent?.trim() || "",
          rowIndex: idx,
        };
      }).filter(r => r.soldOn.match(/\d{2}\/\d{2}\/\d{4}/));
    });

    // PROCESS
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];

      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(4000);

      await page.evaluate(({ program }) => {
        const links = Array.from(document.querySelectorAll("a"));
        const match = links.find(el =>
          el.textContent?.trim().toLowerCase() === program.toLowerCase()
        );
        if (match) (match as HTMLElement).click();
      }, { program: row.program });

      await page.waitForTimeout(3000);

      let modalOpen = await page.evaluate(() => {
        return !!document.querySelector('[role="dialog"], .modal');
      });

      if (!modalOpen) {
        try {
          await (page as any).act(`click program ${row.program}`);
          await page.waitForTimeout(3000);
        } catch {}
      }

      // START DATE
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await (page as any).act(`set "Starts On" to ${row.soldOn}`);
          break;
        } catch {}
      }

      const [m, d, y] = row.soldOn.split("/");
      const nextYear = calcNextBillingYear(parseInt(y), row.program);
      const nextBillingDate = `${m}/${d}/${nextYear}`;

      try {
        await (page as any).act(`set "Next Billing Date" to ${nextBillingDate}`);
      } catch {}

      try {
        await (page as any).act(`click "Save & Complete"`);
        await page.waitForTimeout(3000);

        processed.push({
          ...row,
          nextBillingDate,
        });
      } catch (e: any) {
        failed.push({ ...row, message: e.message });
      }
    }

  } catch (error: any) {
    failed.push({ message: error.message });
  }

  // =============================================================================
  // ✅ MESSAGE BUILDING (ADDED)
  // =============================================================================

  let message = "";

  if (processed.length === 0 && failed.length === 0) {
    message = "No memberships found to process.";
  } else {
    if (processed.length > 0) {
      message += `Membership date correction completed for ${processed.length} membership(s):\n`;
      processed.forEach(p => {
        message += `- ${p.customer} | ${p.program} | Starts On: ${p.soldOn} | Next Billing: ${p.nextBillingDate}\n`;
      });
    }

    if (failed.length > 0) {
      message += `\nFailed ${failed.length} membership(s):\n`;
      failed.forEach(f => {
        message += `- ${f.customer || "unknown"} | ${f.message}\n`;
      });
    }
  }

  return {
    success: failed.length === 0,
    message: message.trim(),
    processedCount: processed.length,
    failedCount: failed.length,
    processed,
    failed,
    sessionUrl,
    elapsedMinutes: parseFloat(((Date.now() - startTime) / 1000 / 60).toFixed(2)),
  };
}

// =============================================================================
// EXPRESS
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership-fix", async (_req, res) => {
  const result = await runMembershipTask();
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
