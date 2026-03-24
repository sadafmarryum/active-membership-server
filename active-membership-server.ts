// active-membership-server.ts
// Stagehand v3 — Mister Quik membership date fixer

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing";

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
// DATE HELPERS
// =============================================================================

function toShortYear(date: string): string {
  const p = date.split("/");
  if (p.length !== 3 || (p[2] || "").length !== 4) return date;
  return p[0] + "/" + p[1] + "/" + (p[2] || "").substring(2);
}

function getModalVariant(program: string): ModalVariant {
  const n = program.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year") || n.includes("5 year")) return "ends-on";
  return "next-billing";
}

function calcSecondDate(soldOnShort: string, program: string): string {
  const p = soldOnShort.split("/");
  if (p.length !== 3) return soldOnShort;
  const year = parseInt(p[2] || "0", 10) + 2000;
  const n = program.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  return p[0] + "/" + p[1] + "/" + String((year + add) % 100).padStart(2, "0");
}

// =============================================================================
// TABLE HELPERS
// =============================================================================

async function waitForRows(page: SPage, ms = 10000): Promise<MembershipRow[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const out: MembershipRow[] = [];
      document.querySelectorAll("table tbody tr").forEach((r, i) => {
        const c = r.querySelectorAll("td");
        if (c.length < 5) return;
        const soldOn = (c[0]?.textContent || "").trim();
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        const p = soldOn.split("/");
        const soldOnShort = p[0] + "/" + p[1] + "/" + (p[2] ? p[2].substring(2) : "");
        out.push({
          soldOn,
          soldOnShort,
          invoice: (c[1]?.textContent || "").trim(),
          job: (c[2]?.textContent || "").trim(),
          customer: (c[3]?.textContent || "").trim(),
          program: (c[4]?.textContent || "").trim(),
          rowIndex: i,
        });
      });
      return out;
    });
    if (rows.length > 0) return rows;
    await page.waitForTimeout(500);
  }
  return [];
}

// =============================================================================
// MODAL HELPERS
// =============================================================================

async function openMembershipModal(page: SPage, customer: string, soldOn: string): Promise<string> {
  const spanId: string = await page.evaluate(
    (args: { customer: string; soldOn: string; stamp: string }): string => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      for (const r of rows) {
        const cells = r.querySelectorAll("td");
        const rowSoldOn = (cells[0]?.textContent || "").trim();
        const rowCustomer = (cells[3]?.textContent || "").trim();
        if (rowSoldOn === args.soldOn && rowCustomer === args.customer) {
          const td = cells[4] as HTMLElement | undefined;
          if (!td) return "";
          const span = td.querySelector<HTMLElement>("span.link") || td.querySelector<HTMLElement>("span");
          if (span) {
            span.id = args.stamp;
            return args.stamp;
          }
          td.id = args.stamp;
          return args.stamp;
        }
      }
      return "";
    },
    { customer, soldOn, stamp: "__sp_" + Date.now() }
  );

  if (!spanId) return "NOT FOUND";

  const coords = await page.evaluate((id: string) => {
    const el = document.getElementById(id);
    if (!el) return { x: 0, y: 0, ok: false };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 0 };
  }, spanId);

  if (!coords.ok) return "COORDS FAILED";

  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x, y: coords.y, button: "none" });
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(80);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1, modifiers: 0 });

  return "OK";
}

async function waitForModal(page: SPage, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return text.includes("Edit Memberships") && text.includes("Starts On");
    });
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForModalClose(page: SPage, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const stillOpen = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return text.includes("Edit Memberships") && text.includes("Save & Complete");
    });
    if (!stillOpen) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

// =============================================================================
// FIELD FINDER (UPDATED)
// =============================================================================

async function findInputByLabel(page: SPage, labelText: string) {
  return page.evaluate((label: string) => {
    const labelLower = label.toLowerCase().trim();

    const allElements = Array.from(document.querySelectorAll("*"));

    for (const el of allElements) {
      const htmlEl = el as HTMLElement;

      let directText = "";
      htmlEl.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          directText += (node.textContent || "").trim() + " ";
        }
      });
      directText = directText.trim().toLowerCase();

      const isMatch =
        directText === labelLower ||
        (labelLower.includes("starts") && directText.includes("starts")) ||
        (labelLower.includes("next billing") && directText.includes("billing")) ||
        (labelLower.includes("ends") && directText.includes("end"));

      if (isMatch && directText.length > 0 && directText.length < 40) {

        const parent = htmlEl.parentElement;
        if (parent) {
          const inputs = Array.from(parent.querySelectorAll("input"));
          for (const inp of inputs) {
            const rect = inp.getBoundingClientRect();
            if (rect.width > 0) {
              return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                found: true,
                debug: "input in parent (deep)"
              };
            }
          }

          const gp = parent.parentElement;
          if (gp) {
            const inputs = Array.from(gp.querySelectorAll("input"));
            for (const inp of inputs) {
              const rect = inp.getBoundingClientRect();
              if (rect.width > 0) {
                return {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                  found: true,
                  debug: "input in grandparent (deep)"
                };
              }
            }
          }
        }
      }
    }

    return { x: 0, y: 0, found: false, debug: "NOT FOUND" };
  }, labelText);
}

// =============================================================================
// TYPE DATE
// =============================================================================

async function typeDate(page: SPage, x: number, y: number, dateValue: string): Promise<void> {
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await page.waitForTimeout(200);

  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(300);
}

// =============================================================================
// CLICK SAVE
// =============================================================================

async function clickSaveComplete(page: SPage): Promise<void> {
  const coords = await page.evaluate(() => {
    const spans = document.querySelectorAll("span[data-v-c7226b75]");
    for (const span of spans) {
      const text = (span.textContent || "").toLowerCase().replace(/\s+/g, " ");
      if (text.includes("save & complete") || (text.includes("save") && text.includes("complete"))) {
        const rect = span.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          found: true
        };
      }
    }
    return { x: 0, y: 0, found: false };
  });

  if (!coords.found) throw new Error("Save button not found");

  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
}

// =============================================================================
// MAIN TASK (ONLY small fallback added)
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

    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const rows = await waitForRows(page, 15000);

    for (const r of rows) {
      try {
        const variant = getModalVariant(r.program);
        const secondDate = calcSecondDate(r.soldOnShort, r.program);
        const secondLabel = variant === "ends-on" ? "Ends On" : "Next Billing Date";

        await openMembershipModal(page, r.customer, r.soldOn);
        await waitForModal(page, 8000);

        let secondField = await findInputByLabel(page, secondLabel);

        // 🔥 placeholder fallback
        if (!secondField.found) {
          const fallback = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
            for (const inp of inputs) {
              const ph = (inp.placeholder || "").toLowerCase();
              const rect = inp.getBoundingClientRect();
              if (rect.width > 0 && (ph.includes("billing") || ph.includes("end"))) {
                return {
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                  found: true
                };
              }
            }
            return { x: 0, y: 0, found: false };
          });
          secondField = fallback;
        }

        if (!secondField.found) {
          failed.push({ ...r, message: "Could not find second date field" });
          continue;
        }

        await typeDate(page, secondField.x, secondField.y, secondDate);
        await clickSaveComplete(page);

        processed.push({
          customer: r.customer,
          job: r.job,
          program: r.program,
          soldOn: r.soldOn,
          startsOn: r.soldOnShort,
          secondDateField: secondLabel,
          secondDateValue: secondDate,
          message: "Saved",
        });

      } catch (err) {
        failed.push({ ...r, message: String(err) });
      }
    }

    return {
      success: true,
      message: "Completed memberships run",
      processedCount: processed.length,
      failedCount: failed.length,
      processed,
      failed,
      elapsedMinutes: Math.round((Date.now() - t0) / 60000),
      sessionUrl,
    };

  } catch (err) {
    return {
      success: false,
      message: String(err),
      processedCount: 0,
      failedCount: 0,
      processed: [],
      failed: [],
      elapsedMinutes: 0,
      sessionUrl,
    };
  } finally {
    await stagehand.close();
  }
}

// =============================================================================
// EXPRESS
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership", async (req: Request, res: Response) => {
  const result = await runMembershipTask();
  res.json(result);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on port ${port}`));
