// active-membership-server.ts
// Stagehand v3 — Mister Quik membership date fixer

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing" | "unknown";

interface MembershipRow {
  soldOn: string;
  soldOnShort: string;
  invoice: string;
  job: string;
  customer: string;
  program: string;
  rowIndex: number;
}
interface ProcessedEntry {
  customer: string; job: string; program: string;
  soldOn: string; startsOn: string;
  secondDateField: string; secondDateValue: string; message: string;
}
interface FailedEntry {
  customer?: string; job?: string; program?: string;
  soldOn?: string; rowIndex?: number; message: string;
}
interface TaskResult {
  success: boolean; message: string;
  processedCount: number; failedCount: number;
  processed: ProcessedEntry[]; failed: FailedEntry[];
  elapsedMinutes: number; sessionUrl: string;
}

// =============================================================================
// DATE HELPERS
// =============================================================================

function getModalVariant(program: string): ModalVariant {
  const n = program.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year") || n.includes("5 year")) return "ends-on";
  return "next-billing";
}

function calcSecondDate(soldOnShort: string, program: string): string {
  const p = soldOnShort.split("/");
  const year = parseInt(p[2]) + 2000;
  let add = 1;
  const n = program.toLowerCase();

  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;

  return `${p[0]}/${p[1]}/${String((year + add) % 100).padStart(2, "0")}`;
}

// =============================================================================
// NEW FIX: WAIT FOR ROW DISAPPEAR
// =============================================================================

async function waitForRowToDisappear(
  page: SPage,
  soldOn: string,
  customer: string,
  timeout = 15000
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const stillExists: boolean = await page.evaluate(
      ({ soldOn, customer }) => {
        const rows = Array.from(document.querySelectorAll("table tbody tr"));
        return rows.some((r) => {
          const cells = r.querySelectorAll("td");
          const s = (cells[0]?.textContent || "").trim();
          const c = (cells[3]?.textContent || "").trim();
          return s === soldOn && c === customer;
        });
      },
      { soldOn, customer }
    );

    if (!stillExists) return true;

    await page.waitForTimeout(500);
  }

  return false;
}

// =============================================================================
// MAIN TASK
// =============================================================================

async function runMembershipTask(): Promise<TaskResult> {
  const t0 = Date.now();

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: { modelName: "google/gemini-2.5-flash", apiKey: process.env.GEMINI_API_KEY ?? "" },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";
  const processed: ProcessedEntry[] = [];
  const failed: FailedEntry[] = [];

  try {
    await stagehand.init();
    sessionUrl = "https://browserbase.com/sessions/" + stagehand.browserbaseSessionID;

    const page: SPage = stagehand.context.activePage()!;

    // LOGIN
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      await page.locator("input[type=email]").fill(process.env.SERA_EMAIL!);
      await page.locator("input[type=password]").fill(process.env.SERA_PASSWORD!);
      await page.locator("button[type=submit]").click();
      await page.waitForTimeout(5000);
    }

    // GO TO MEMBERSHIPS
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const rows: MembershipRow[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table tbody tr")).map((r, i) => {
        const c = r.querySelectorAll("td");
        const soldOn = c[0]?.textContent?.trim() || "";
        const p = soldOn.split("/");

        return {
          soldOn,
          soldOnShort: `${p[0]}/${p[1]}/${p[2]?.slice(2)}`,
          invoice: c[1]?.textContent?.trim() || "",
          job: c[2]?.textContent?.trim() || "",
          customer: c[3]?.textContent?.trim() || "",
          program: c[4]?.textContent?.trim() || "",
          rowIndex: i,
        };
      });
    });

    for (const row of rows) {
      try {
        const date2 = calcSecondDate(row.soldOnShort, row.program);
        const variant = getModalVariant(row.program);
        const field2 = variant === "ends-on" ? "Ends On" : "Next Billing Date";

        console.log(`Processing: ${row.customer}`);

        // CLICK ROW
        await page.locator("table tbody tr").nth(row.rowIndex).locator("td").nth(4).click();

        await page.waitForTimeout(1500);

        // TYPE DATES
        await page.getByLabel("Starts On").fill(row.soldOnShort);
        await page.getByLabel(field2).fill(date2);

        // SAVE
        await page.getByText("Save & Complete").click();

        // WAIT MODAL CLOSE
        await page.waitForTimeout(2000);

        // ✅ NEW FIX HERE
        console.log("  Waiting for row to disappear...");

        const removed = await waitForRowToDisappear(
          page,
          row.soldOn,
          row.customer,
          15000
        );

        if (!removed) {
          failed.push({ ...row, message: "Row still present after waiting — possible save failure" });
          continue;
        }

        processed.push({
          customer: row.customer,
          job: row.job,
          program: row.program,
          soldOn: row.soldOn,
          startsOn: row.soldOnShort,
          secondDateField: field2,
          secondDateValue: date2,
          message: `${row.customer} updated`,
        });

      } catch (e: any) {
        failed.push({ ...row, message: e.message });
      }
    }

  } catch (err: any) {
    failed.push({ message: err.message });
  } finally {
    await stagehand.close();
  }

  return {
    success: failed.length === 0,
    message: `Processed: ${processed.length}, Failed: ${failed.length}`,
    processedCount: processed.length,
    failedCount: failed.length,
    processed,
    failed,
    elapsedMinutes: Number(((Date.now() - t0) / 60000).toFixed(2)),
    sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership-fix", async (_req, res) => {
  const result = await runMembershipTask();
  res.json(result);
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
