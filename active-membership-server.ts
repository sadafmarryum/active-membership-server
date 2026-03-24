// active-membership-server.ts
// Stagehand v3 — Mister Quik membership date fixer
//
// LOGIC:
// 1. Table "Sold On" date → Modal "Starts On" field (converted to MM/DD/YY format)
// 2. Calculate second date based on program:
//    - "10-year" or "10 year" → Ends On = Sold On + 10 years
//    - "5-year" or "5 year"   → Ends On = Sold On + 5 years
//    - All others (auto-renew) → Next Billing Date = Sold On + 1 year
// 3. Click Save & Complete button (span[data-v-c7226b75])

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing";

interface MembershipRow {
  soldOn: string;        // MM/DD/YYYY from table
  soldOnShort: string;   // MM/DD/YY for modal input
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

  // Get coordinates and click
  const coords = await page.evaluate((id: string): { x: number; y: number; ok: boolean } => {
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
    const open = await page.evaluate((): boolean => {
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
    const stillOpen = await page.evaluate((): boolean => {
      const text = document.body.innerText || "";
      return text.includes("Edit Memberships") && text.includes("Save & Complete");
    });
    if (!stillOpen) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

// =============================================================================
// INPUT FIELD HELPERS - Find input by nearby label text
// =============================================================================

interface FieldCoords {
  x: number;
  y: number;
  found: boolean;
  debug: string;
}

async function findInputByLabel(page: SPage, labelText: string): Promise<FieldCoords> {
  return page.evaluate((label: string): FieldCoords => {
    const labelLower = label.toLowerCase().trim();
    let debug = "Searching: " + label;

    // Scan all elements for matching text
    const allElements = Array.from(document.querySelectorAll("*"));

    for (const el of allElements) {
      const htmlEl = el as HTMLElement;

      // Get direct text content only (not from children)
      let directText = "";
      htmlEl.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          directText += (node.textContent || "").trim() + " ";
        }
      });
      directText = directText.trim().toLowerCase();

      // Match the label
      const isMatch =
        directText === labelLower ||
        directText === labelLower.replace(" date", "") ||
        (labelLower.includes("starts") && directText.includes("starts")) ||
        (labelLower.includes("next billing") && directText.includes("next billing")) ||
        (labelLower.includes("ends") && directText.includes("ends"));

      if (isMatch && directText.length > 0 && directText.length < 30) {
        debug += " | Found: '" + directText + "' in <" + htmlEl.tagName + ">";

        // Find nearby input - check siblings first
        let sibling = htmlEl.nextElementSibling;
        while (sibling) {
          if (sibling.tagName === "INPUT") {
            const rect = sibling.getBoundingClientRect();
            if (rect.width > 0) {
              return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), found: true, debug: debug + " | input=sibling" };
            }
          }
          const inp = sibling.querySelector("input");
          if (inp) {
            const rect = inp.getBoundingClientRect();
            if (rect.width > 0) {
              return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), found: true, debug: debug + " | input in sibling" };
            }
          }
          sibling = sibling.nextElementSibling;
        }

        // Check parent
        const parent = htmlEl.parentElement;
        if (parent) {
          const inp = parent.querySelector("input");
          if (inp) {
            const rect = inp.getBoundingClientRect();
            if (rect.width > 0) {
              return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), found: true, debug: debug + " | input in parent" };
            }
          }

          // Check grandparent
          const gp = parent.parentElement;
          if (gp) {
            const inp = gp.querySelector("input");
            if (inp) {
              const rect = inp.getBoundingClientRect();
              if (rect.width > 0) {
                return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), found: true, debug: debug + " | input in grandparent" };
              }
            }
          }
        }
      }
    }

    return { x: 0, y: 0, found: false, debug: debug + " | NOT FOUND" };
  }, labelText);
}

// =============================================================================
// TYPE DATE INTO INPUT AT COORDINATES
// =============================================================================

async function typeDate(page: SPage, x: number, y: number, dateValue: string): Promise<void> {
  // Click to focus
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(300);

  // Triple-click to select all
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 3, modifiers: 0 });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 3, modifiers: 0 });
  await page.waitForTimeout(150);

  // Ctrl+A to select all
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.waitForTimeout(100);

  // Type the date
  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(300);

  // Escape to close any date picker popup
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.waitForTimeout(200);

  // Tab to trigger change event
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.waitForTimeout(200);

  // Escape again to ensure picker is closed
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.waitForTimeout(100);
}

// =============================================================================
// CLICK SAVE & COMPLETE - Using span[data-v-c7226b75]
// =============================================================================

async function clickSaveComplete(page: SPage): Promise<string> {
  const coords = await page.evaluate((): FieldCoords => {
    // Primary: Find span with Vue attribute data-v-c7226b75
    const vueSpans = document.querySelectorAll<HTMLElement>("span[data-v-c7226b75]");
    for (let i = 0; i < vueSpans.length; i++) {
      const span = vueSpans[i];
      if (!span) continue;
      const text = (span.textContent || "").toLowerCase();
      if (text.includes("save") && text.includes("complete")) {
        span.scrollIntoView({ block: "center" });
        const rect = span.getBoundingClientRect();
        if (rect.width > 0) {
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            found: true,
            debug: "Vue span[data-v-c7226b75]: '" + span.textContent + "'"
          };
        }
      }
    }

    // Fallback: any element with Save & Complete text
    const allEls = document.querySelectorAll<HTMLElement>("button, span, a");
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (!el) continue;
      const text = (el.textContent || "").trim();
      if (text === "Save & Complete" || text === "Save &amp; Complete") {
        el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 300) {
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            found: true,
            debug: "Fallback <" + el.tagName + ">: '" + text + "'"
          };
        }
      }
    }

    return { x: 0, y: 0, found: false, debug: "Save & Complete NOT FOUND" };
  });

  console.log("  Save button: " + coords.debug);

  if (!coords.found) {
    throw new Error("Save & Complete button not found");
  }

  // Click the button
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x, y: coords.y, button: "none" });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(200);

  return coords.debug;
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
    console.log("Session: " + sessionUrl);

    const page: SPage = stagehand.context.activePage()!;

    // ── Login ──────────────────────────────────────────────────────────
    console.log("[1] Login");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      await page.locator("input[type=email]").first().fill(process.env.SERA_EMAIL ?? "mcc@stratablue.com");
      await page.locator("input[type=password]").first().fill(process.env.SERA_PASSWORD ?? "");
      await page.waitForTimeout(400);

      await page.evaluate((): void => {
        const btn = Array.from(document.querySelectorAll<HTMLElement>("button,input[type=submit]"))
          .find(el => {
            const t = (el.textContent || "").toLowerCase().trim();
            const v = ((el as HTMLInputElement).value || "").toLowerCase();
            return t === "sign in" || t === "login" || v === "login" || v === "sign in";
          });
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);
    }

    // ── Navigate to memberships ────────────────────────────────────────
    console.log("[2] Navigate to /memberships");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const rows = await waitForRows(page, 15000);
    if (rows.length === 0) {
      return { success: true, message: "No memberships found", processedCount: 0, failedCount: 0, processed: [], failed: [], elapsedMinutes: 0, sessionUrl };
    }

    console.log("[3] Found " + rows.length + " memberships to process");

    // ── Process each row ───────────────────────────────────────────────
    for (const r of rows) {
      console.log("\n========================================");
      console.log("Customer: " + r.customer);
      console.log("Program:  " + r.program);
      console.log("Sold On:  " + r.soldOn + " → " + r.soldOnShort);
      console.log("========================================");

      try {
        // Calculate dates
        const variant = getModalVariant(r.program);
        const startsOnDate = r.soldOnShort;  // Starts On = Sold On (short format)
        const secondDate = calcSecondDate(r.soldOnShort, r.program);
        const secondLabel = variant === "ends-on" ? "Ends On" : "Next Billing Date";

        console.log("  Variant: " + variant);
        console.log("  Starts On: " + startsOnDate);
        console.log("  " + secondLabel + ": " + secondDate);

        // Open modal
        const openResult = await openMembershipModal(page, r.customer, r.soldOn);
        if (openResult !== "OK") {
          failed.push({ ...r, message: "Failed to open modal: " + openResult });
          continue;
        }

        const modalOpened = await waitForModal(page, 8000);
        if (!modalOpened) {
          failed.push({ ...r, message: "Modal did not open" });
          continue;
        }
        console.log("  Modal opened");
        await page.waitForTimeout(800);

        // ── Fill "Starts On" field ─────────────────────────────────────
        console.log("  Finding 'Starts On' field...");
        const startsOnField = await findInputByLabel(page, "Starts On");
        console.log("  " + startsOnField.debug);

        if (!startsOnField.found) {
          failed.push({ ...r, message: "Could not find 'Starts On' field" });
          continue;
        }

        console.log("  Typing '" + startsOnDate + "' into Starts On");
        await typeDate(page, startsOnField.x, startsOnField.y, startsOnDate);
        await page.waitForTimeout(500);

        // ── Fill second date field ─────────────────────────────────────
        console.log("  Finding '" + secondLabel + "' field...");
        let secondField = await findInputByLabel(page, secondLabel);
        console.log("  " + secondField.debug);

        // Try alternative labels if not found
        if (!secondField.found) {
          const altLabels = variant === "ends-on"
            ? ["End Date", "Ends", "Expiration"]
            : ["Next Billing", "Billing Date", "Renewal"];

          for (const alt of altLabels) {
            console.log("  Trying alternative: '" + alt + "'");
            secondField = await findInputByLabel(page, alt);
            if (secondField.found) {
              console.log("  Found with '" + alt + "': " + secondField.debug);
              break;
            }
          }
        }

        if (!secondField.found) {
          failed.push({ ...r, message: "Could not find '" + secondLabel + "' field" });
          continue;
        }

        console.log("  Typing '" + secondDate + "' into " + secondLabel);
        await typeDate(page, secondField.x, secondField.y, secondDate);
        await page.waitForTimeout(500);

        // ── Click Save & Complete ──────────────────────────────────────
        console.log("  Clicking Save & Complete...");
        await clickSaveComplete(page);

        // Wait for modal to close
        const closed = await waitForModalClose(page, 10000);
        console.log("  Modal closed: " + closed);

        // Wait for row to disappear (up to 3 minutes)
        console.log("  Waiting for row to disappear...");
        let removed = false;
        const waitStart = Date.now();

        while (Date.now() - waitStart < 180000) {
          const stillThere = await page.evaluate(
            (args: { soldOn: string; customer: string }): boolean => {
              return Array.from(document.querySelectorAll("table tbody tr")).some(row => {
                const cells = row.querySelectorAll("td");
                return (cells[0]?.textContent || "").trim() === args.soldOn &&
                       (cells[3]?.textContent || "").trim() === args.customer;
              });
            },
            { soldOn: r.soldOn, customer: r.customer }
          );

          if (!stillThere) {
            removed = true;
            break;
          }
          console.log("  Row still present, waiting 5s...");
          await page.waitForTimeout(5000);
        }

        if (!removed) {
          failed.push({ ...r, message: "Row not removed after 3 minutes" });
          continue;
        }

        console.log("  ✓ SUCCESS: Row removed");
        processed.push({
          customer: r.customer,
          job: r.job,
          program: r.program,
          soldOn: r.soldOn,
          startsOn: startsOnDate,
          secondDateField: secondLabel,
          secondDateValue: secondDate,
          message: "Saved & Completed",
        });

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log("  ✗ FAILED: " + errMsg);
        failed.push({ ...r, message: errMsg });

        // Try to close modal with Escape
        try {
          await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await page.waitForTimeout(500);
        } catch (e) { /* ignore */ }
      }
    }

    const elapsedMinutes = Math.round((Date.now() - t0) / 60000);
    return {
      success: true,
      message: "Completed memberships run",
      processedCount: processed.length,
      failedCount: failed.length,
      processed,
      failed,
      elapsedMinutes,
      sessionUrl,
    };

  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      processedCount: processed.length,
      failedCount: failed.length,
      processed,
      failed,
      elapsedMinutes: Math.round((Date.now() - t0) / 60000),
      sessionUrl,
    };
  } finally {
    await stagehand.close();
  }
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership", async (req: Request, res: Response) => {
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on port ${port}`));
