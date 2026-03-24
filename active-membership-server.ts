// active-membership-server.ts
// Stagehand v3 — Mister Quik membership date fixer
//
// CORRECT FLOW:
//   1. Login
//   2. Navigate to /memberships ONCE
//   3. Read all rows
//   4. For each row:
//      a. Click the program text in td[4] using a REAL CDP mouse click (not JS .click())
//      b. Wait for modal to open
//      c. Set Starts On and Next Billing Date / Ends On
//      d. Click Save & Complete
//      e. Wait for modal to close — then move to next row (NO PAGE RELOAD)
//      f. Wait up to 3 minutes for the row to disappear from the table

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage        = NonNullable<ReturnType<V3["context"]["activePage"]>>;
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

function toShortYear(date: string): string {
  const p = date.split("/");
  if (p.length !== 3 || (p[2] || "").length !== 4) return date;
  return p[0] + "/" + p[1] + "/" + (p[2] || "").substring(2);
}

function getModalVariant(program: string): ModalVariant {
  const n = program.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
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
// PAGE HELPERS
// =============================================================================

async function waitForRows(page: SPage, ms = 10000): Promise<MembershipRow[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const out: MembershipRow[] = [];
      document.querySelectorAll("table tbody tr").forEach(function(r, i) {
        const c = r.querySelectorAll("td");
        if (c.length < 5) return;
        const soldOn = (c[0] ? c[0].textContent || "" : "").trim();
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        const p = soldOn.split("/");
        const soldOnShort = p[0] + "/" + p[1] + "/" + (p[2] ? p[2].substring(2) : "");
        out.push({
          soldOn, soldOnShort,
          invoice:  (c[1] ? c[1].textContent || "" : "").trim(),
          job:      (c[2] ? c[2].textContent || "" : "").trim(),
          customer: (c[3] ? c[3].textContent || "" : "").trim(),
          program:  (c[4] ? c[4].textContent || "" : "").trim(),
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

async function openMembershipModal(
  stagehand: V3,
  page: SPage,
  customer: string,
  soldOn: string,
  program: string
): Promise<string> {
  const spanId: string = await page.evaluate(
    function(args: { customer: string; soldOn: string; stamp: string }): string {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] as HTMLElement;
        if (!r) continue;
        const cells = r.querySelectorAll("td");
        const rowSoldOn   = (cells[0] ? cells[0].textContent || "" : "").trim();
        const rowCustomer = (cells[3] ? cells[3].textContent || "" : "").trim();
        if (rowSoldOn === args.soldOn && rowCustomer === args.customer) {
          const td = cells[4] as HTMLElement | undefined;
          if (!td) return "";
          const span = td.querySelector<HTMLElement>("span.link");
          if (span) { span.id = args.stamp; return args.stamp; }
          const anySpan = td.querySelector<HTMLElement>("span");
          if (anySpan) { anySpan.id = args.stamp; return args.stamp; }
          td.id = args.stamp;
          return args.stamp;
        }
      }
      return "";
    },
    { customer, soldOn, stamp: "__sp_" + Date.now() }
  );

  if (!spanId) return "NOT FOUND: no matching row for " + customer;

  try {
    await page.locator("#" + spanId).first().click();
    return "locator span.link click";
  } catch (e: unknown) {
    console.log("  locator span click failed: " + (e instanceof Error ? e.message.split("\n")[0].substring(0, 60) : String(e)));
  }

  const coords: { x: number; y: number; ok: boolean } = await page.evaluate(
    function(id: string): { x: number; y: number; ok: boolean } {
      const el = document.getElementById(id);
      if (!el) return { x: 0, y: 0, ok: false };
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 0 };
    },
    spanId
  );

  if (coords.ok) {
    const { x, y } = coords;
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",    x, y, button: "none" });
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1, modifiers: 0 });
    await page.waitForTimeout(80);
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
    return "CDP span at (" + x + "," + y + ")";
  }

  return "ALL FAILED";
}

async function waitForModal(page: SPage, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open: boolean = await page.evaluate((): boolean => {
      const d = document.querySelector<HTMLElement>('.modal.show,[role="dialog"]');
      if (d && d.offsetParent !== null) return true;
      const sm = document.querySelector("sera-modal");
      if (sm && sm.shadowRoot && sm.shadowRoot.childElementCount > 0) return true;
      return Array.from(document.querySelectorAll<HTMLElement>("h4,h5,.modal-title"))
        .some(function(h) { return (h.textContent || "").includes("Edit Memberships") && h.offsetParent !== null; });
    });
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForModalClose(page: SPage, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open: boolean = await page.evaluate((): boolean => {
      const d = document.querySelector<HTMLElement>('.modal.show,[role="dialog"]');
      if (d && d.offsetParent !== null) return true;
      const sm = document.querySelector("sera-modal");
      return !!(sm && sm.shadowRoot && sm.shadowRoot.childElementCount > 0);
    });
    if (!open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function detectVariant(page: SPage): Promise<ModalVariant> {
  return page.evaluate((): ModalVariant => {
    const t = document.body.innerText.toLowerCase();
    if (t.includes("ends on")) return "ends-on";
    if (t.includes("next billing")) return "next-billing";
    const sm = document.querySelector("sera-modal");
    if (sm && sm.shadowRoot) {
      const st = (sm.shadowRoot.textContent || "").toLowerCase();
      if (st.includes("ends on")) return "ends-on";
      if (st.includes("next billing")) return "next-billing";
    }
    return "unknown";
  });
}

async function typeDate(page: SPage, labelText: string, dateValue: string): Promise<string> {
  const inputId: string = await page.evaluate(
    function(args: { label: string; stamp: string }): string {
      function findInput(root: Document | ShadowRoot): HTMLInputElement | null {
        const lbl = Array.from(root.querySelectorAll<HTMLLabelElement>("label"))
          .find(function(l) { return (l.textContent || "").trim().toLowerCase() === args.label.toLowerCase(); });
        if (!lbl) return null;
        const forId = lbl.getAttribute("for");
        if (forId) {
          const el = (root as Document).getElementById ? (root as Document).getElementById(forId) : null;
          if (el) return el as HTMLInputElement;
        }
        let s = lbl.nextElementSibling;
        while (s) {
          if (s.tagName === "INPUT") return s as HTMLInputElement;
          const i = s.querySelector<HTMLInputElement>("input");
          if (i) return i;
          s = s.nextElementSibling;
        }
        return lbl.querySelector<HTMLInputElement>("input");
      }
      let el = findInput(document);
      if (!el) {
        const sm = document.querySelector("sera-modal");
        if (sm && sm.shadowRoot) el = findInput(sm.shadowRoot);
      }
      if (!el) return "";
      if (!el.id) el.id = args.stamp;
      return el.id;
    },
    { label: labelText, stamp: "__d_" + labelText.replace(/\W/g, "") }
  );

  if (!inputId) throw new Error("Label not found: " + labelText);

  const loc = page.locator("#" + inputId).first();
  await loc.click({ clickCount: 3 });
  await page.waitForTimeout(150);
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp",   key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(200);
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.waitForTimeout(300);

  return await page.evaluate(function(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) return el.value;
    const sm = document.querySelector("sera-modal");
    if (sm && sm.shadowRoot) {
      const s = sm.shadowRoot.getElementById(id) as HTMLInputElement | null;
      if (s) return s.value;
    }
    return "";
  }, inputId);
}

async function clickSave(page: SPage): Promise<string> {
  const coords: { x: number; y: number; found: boolean; debug: string } = await page.evaluate((): { x: number; y: number; found: boolean; debug: string } => {
    function findSpan(root: Document | ShadowRoot): HTMLElement | null {
      const byAttr = Array.from(root.querySelectorAll<HTMLElement>("span[data-v-c7226b75]"))
        .find(function(el) {
          return (el.textContent || "").trim().toLowerCase().includes("save");
        });
      if (byAttr) return byAttr;
      const btns = Array.from(root.querySelectorAll<HTMLElement>("button"));
      for (let i = 0; i < btns.length; i++) {
        const btn = btns[i];
        if (!btn) continue;
        const t = (btn.textContent || "").trim().toLowerCase();
        if (t.includes("save") && t.includes("complete")) return btn;
      }
      return null;
    }

    let el = findSpan(document);
    if (!el) {
      const sm = document.querySelector("sera-modal");
      if (sm && sm.shadowRoot) {
        el = findSpan(sm.shadowRoot);
        if (!el) {
          Array.from(sm.shadowRoot.querySelectorAll("*")).forEach(function(child) {
            if (!el && (child as HTMLElement).shadowRoot) {
              el = findSpan((child as HTMLElement).shadowRoot as ShadowRoot);
            }
          });
        }
      }
    }

    if (!el) return { x: 0, y: 0, found: false, debug: "span[data-v-c7226b75] not found" };

    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top  + r.height / 2),
      found: r.width > 0,
      debug: el.tagName + "[" + el.className + "] text=" + (el.textContent || "").trim() + " at " + Math.round(r.left) + "," + Math.round(r.top),
    };
  });

  console.log("  Save btn: " + coords.debug);

  if (!coords.found) throw new Error("Save & Complete not found: " + coords.debug);

  const { x, y } = coords;
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",    x, y, button: "none" });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);

  return "CDP at (" + x + "," + y + ") on " + coords.debug;
}

// =============================================================================
// MAIN TASK
// =============================================================================

async function runMembershipTask(): Promise<TaskResult> {
  const t0 = Date.now();
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: { modelName: "google/gemini-2.5-flash", apiKey: process.env.GEMINI_API_KEY ?? "" },
    verbose: 1, disablePino: true,
  });

  let sessionUrl = "";
  const processed: ProcessedEntry[] = [];
  const failed: FailedEntry[]       = [];

  try {
    await stagehand.init();
    sessionUrl = "https://browserbase.com/sessions/" + stagehand.browserbaseSessionID;
    console.log("Session: " + sessionUrl);

    const page: SPage = stagehand.context.activePage()!;

    // ── Step 1: Login ──────────────────────────────────────────────────
    console.log("[1] Login");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      await page.locator("input[type=email]").first().fill(process.env.SERA_EMAIL ?? "mcc@stratablue.com");
      await page.locator("input[type=password]").first().fill(process.env.SERA_PASSWORD ?? "");
      await page.waitForTimeout(400);
      const clicked: boolean = await page.evaluate((): boolean => {
        const btn = Array.from(document.querySelectorAll<HTMLElement>("button,input[type=submit]"))
          .find(function(el) {
            const t = (el.textContent || "").toLowerCase().trim();
            const v = ((el as HTMLInputElement).value || "").toLowerCase();
            return t === "sign in" || t === "login" || v === "login" || v === "sign in";
          });
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) throw new Error("Cannot click login button");
      await page.waitForTimeout(5000);
    }

    console.log("[2] Navigate /memberships");
    await page.goto("https://misterquik.sera.tech/admins/memberships");
    await page.waitForTimeout(3000);

    const rows = await waitForRows(page, 15000);
    if (rows.length === 0) {
      console.log("No memberships found");
      return { success: true, message: "No memberships found", processedCount: 0, failedCount: 0, processed: [], failed: [], elapsedMinutes: 0, sessionUrl };
    }

    console.log("[3] Found " + rows.length + " memberships");
    for (let r of rows) {
      console.log("Processing row: " + r.customer + " / " + r.program + " / " + r.soldOn);
      try {
        const clickRes = await openMembershipModal(stagehand, page, r.customer, r.soldOn, r.program);
        if (clickRes.startsWith("NOT FOUND")) {
          failed.push({ ...r, message: clickRes });
          continue;
        }
        const modalOpened = await waitForModal(page, 8000);
        if (!modalOpened) { failed.push({ ...r, message: "Modal did not open" }); continue; }

        const variant = getModalVariant(r.program);
        const secondDate = calcSecondDate(r.soldOnShort, r.program);

        const startsOnValue = await typeDate(page, "Starts On", r.soldOnShort);
        let secondValue = "";
        if (variant === "next-billing") {
          secondValue = await typeDate(page, "Next Billing Date", secondDate);
        } else if (variant === "ends-on") {
          secondValue = await typeDate(page, "Ends On", secondDate);
        } else {
          secondValue = await typeDate(page, "Next Billing Date", secondDate);
        }

        console.log("  Clicking Save & Complete...");
        await clickSave(page);
        await waitForModalClose(page, 10000);

        // ── NEW LOGIC: Wait up to 3 minutes for row to disappear ──────
        console.log("  Waiting up to 3 minutes for row to be removed...");

        let rowRemoved = false;
        const startTime = Date.now();
        while (Date.now() - startTime < 180000) { // 3 minutes
          const stillThere: boolean = await page.evaluate(
            function(args: { soldOn: string; customer: string }): boolean {
              const rows = Array.from(document.querySelectorAll("table tbody tr"));
              return rows.some(function(r) {
                const cells = r.querySelectorAll("td");
                const s = (cells[0] ? (cells[0].textContent || "").trim() : "");
                const c = (cells[3] ? (cells[3].textContent || "").trim() : "");
                return s === args.soldOn && c === args.customer;
              });
            },
            { soldOn: r.soldOn, customer: r.customer }
          );

          if (!stillThere) { rowRemoved = true; break; }
          console.log("  Still present... retrying in 5s");
          await page.waitForTimeout(5000);
        }

        if (!rowRemoved) {
          failed.push({ ...r, message: "Row not removed after 3 minutes" });
          console.log("  ERROR: row still in table after 3 minutes");
          continue;
        }

        processed.push({
          customer: r.customer,
          job: r.job,
          program: r.program,
          soldOn: r.soldOn,
          startsOn: startsOnValue,
          secondDateField: variant,
          secondDateValue: secondValue,
          message: "Saved & Completed",
        });

      } catch (err: unknown) {
        failed.push({ ...r, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }

    const elapsedMinutes = Math.round((Date.now() - t0) / 60000);
    return { success: true, message: "Completed memberships run", processedCount: processed.length, failedCount: failed.length, processed, failed, elapsedMinutes, sessionUrl };

  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err), processedCount: processed.length, failedCount: failed.length, processed, failed, elapsedMinutes: Math.round((Date.now() - t0)/60000), sessionUrl };
  } finally {
    await stagehand.close();
  }
}

// =============================================================================
// EXPRESS SERVER ENDPOINT
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership", async (req: Request, res: Response) => {
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server listening on port ${port}`));
