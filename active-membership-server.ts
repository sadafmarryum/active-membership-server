// active-membership-server.ts
import { Stagehand } from "@browserbasehq/stagehand";
import express from "express";

function calcNextBillingYear(startsOnYear: number, programName: string): number {
  const name = programName.toLowerCase();
  if (name.includes("10-year") || name.includes("10 year")) return startsOnYear + 10;
  if (name.includes("5-year")  || name.includes("5 year"))  return startsOnYear + 5;
  return startsOnYear + 1; // Auto-Renew or default
}

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
  const failed: any[] = [];

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    const page = stagehand.context.pages()[0];

    // ---------------- LOGIN ----------------
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(2000);
    if ((await page.url()).includes("/login")) {
      await page.locator('input[type="email"]').first().fill(process.env.SERA_EMAIL || "");
      await page.locator('input[type="password"]').first().fill(process.env.SERA_PASSWORD || "");
      await page.locator('button[type="submit"]').first().click();
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!(await page.url()).includes("/login")) break;
      }
    }

    // ---------------- NAVIGATE MEMBERSHIPS ----------------
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(4000);

    // ---------------- READ ROWS ----------------
    const allRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const data: any[] = [];
      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;
        const soldOn = cells[0]?.textContent?.trim() || "";
        const invoice = cells[1]?.textContent?.trim() || "";
        const job = cells[2]?.textContent?.trim() || "";
        const customer = cells[3]?.textContent?.trim() || "";
        const program = cells[4]?.textContent?.trim() || "";
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        data.push({ soldOn, invoice, job, customer, program, rowIndex: idx });
      });
      return data;
    });

    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      console.log(`Processing ${row.customer} | ${row.program}`);

      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(3000);

      // CLICK PROGRAM LINK
      const clicked = await page.evaluate(({ program }) => {
        const links = Array.from(document.querySelectorAll("a"));
        const match = links.find(el =>
          el.textContent?.trim().toLowerCase() === program.toLowerCase() &&
          (el as HTMLElement).offsetParent !== null
        );
        if (match) { (match as HTMLElement).click(); return true; }
        return false;
      }, { program: row.program });

      if (!clicked) {
        failed.push({ ...row, message: "Program link not found/clickable" });
        continue;
      }

      await page.waitForTimeout(2000);

      // CHECK MODAL OPEN
      let modalOpen = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], .modal, sera-modal');
        return !!(modal && (modal as HTMLElement).offsetParent !== null);
      });

      if (!modalOpen) {
        try { await (page as any).act(`Click program ${row.program} to open modal`); } catch {}
        await page.waitForTimeout(2000);
        modalOpen = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], .modal, sera-modal');
          return !!(modal && (modal as HTMLElement).offsetParent !== null);
        });
      }

      if (!modalOpen) {
        failed.push({ ...row, message: "Modal did not open" });
        continue;
      }

      // SET STARTS ON
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { await (page as any).act(`Set "Starts On" to ${row.soldOn}`); break; } catch {}
      }

      // CALCULATE NEXT BILLING
      const [m, d, y] = row.soldOn.split("/");
      const nextYear = calcNextBillingYear(parseInt(y), row.program);
      const nextBillingDate = `${m}/${d}/${nextYear}`;

      try { await (page as any).act(`Set "Next Billing Date" to ${nextBillingDate}`); } catch {}

      // SAVE & COMPLETE
      try {
        await (page as any).act(`Click "Save & Complete"`);
        await page.waitForTimeout(1500);
        processed.push({ ...row, nextBillingDate });
      } catch (e: any) {
        failed.push({ ...row, message: e.message });
      }
    }

  } catch (err: any) {
    failed.push({ message: err.message });
  } finally {
    await stagehand.close();
  }

  // BUILD MESSAGE
  let message = "";
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
  if (!message) message = "No memberships found to process.";

  return {
    success: failed.length === 0,
    message: message.trim(),
    processedCount: processed.length,
    failedCount: failed.length,
    processed,
    failed,
    sessionUrl,
    elapsedMinutes: parseFloat(((Date.now() - startTime)/1000/60).toFixed(2)),
  };
}

// EXPRESS SERVER
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
