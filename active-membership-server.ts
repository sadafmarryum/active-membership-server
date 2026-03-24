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
//      e. Wait for modal to close AND row to disappear — then move to next row

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
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 });
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
  const coords: { x: number; y: number; found: boolean; debug: string } = await page.evaluate(() => {
    function findSpan(root: Document | ShadowRoot): HTMLElement | null {
      const byAttr = Array.from(root.querySelectorAll<HTMLElement>("span[data-v-c7226b75]"))
        .find(el => (el.textContent || "").trim().toLowerCase().includes("save"));
      if (byAttr) return byAttr;
      const btns = Array.from(root.querySelectorAll<HTMLElement>("button"));
      for (const btn of btns) {
        const t = (btn.textContent || "").trim().toLowerCase();
        if (t.includes("save") && t.includes("complete")) return btn;
      }
      return null;
    }

    let el = findSpan(document);
    if (!el) {
      const sm = document.querySelector("sera-modal");
      if (sm && sm.shadowRoot) el = findSpan(sm.shadowRoot);
    }

    if (!el) return { x: 0, y: 0, found: false, debug: "Save button not found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), found: r.width > 0, debug: el.tagName + "[" + el.className + "] text=" + (el.textContent || "").trim() };
  });

  if (!coords.found) throw new Error("Save & Complete not found: " + coords.debug);

  const { x, y } = coords;
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);

  return "CDP at (" + x + "," + y + ") on " + coords.debug;
}

// ── NEW HELPER: Wait for row to disappear after save ──────────────

async function waitForRowRemoval(page: SPage, soldOn: string, customer: string, timeout = 120000, interval = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const stillThere = await page.evaluate((args: { soldOn: string; customer: string }) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.some(r => {
        const cells = r.querySelectorAll("td");
        const s = (cells[0] ? (cells[0].textContent || "").trim() : "");
        const c = (cells[3] ? (cells[3].textContent || "").trim() : "");
        return s === args.soldOn && c === args.customer;
      });
    }, { soldOn, customer });
    if (!stillThere) return true;
    await page.waitForTimeout(interval);
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
    verbose: 1, disablePino: true,
  });

  let sessionUrl = "";
  const processed: ProcessedEntry[] = [];
  const failed: FailedEntry[] = [];

  try {
    await stagehand.init();
    sessionUrl = "https://browserbase.com/sessions/" + stagehand.browserbaseSessionID;
    console.log("Session: " + sessionUrl);

    const page: SPage = stagehand.context.activePage()!;

    // ── LOGIN ─────────────────────────
    console.log("[1] Login");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      await page.locator("input[type=email]").first().fill(process.env.SERA_EMAIL ?? "mcc@stratablue.com");
      await page.locator("input[type=password]").first().fill(process.env.SERA_PASSWORD ?? "");
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll<HTMLElement>("button,input[type=submit]"))
          .find(el => ["sign in","login","log in"].includes((el.textContent || "").trim().toLowerCase()));
        if (btn) (btn as HTMLElement).click();
      });
      await page.waitForTimeout(4000);
    }

    // ── NAV TO MEMBERSHIPS ────────────
    console.log("[2] Go /memberships");
    await page.goto("https://misterquik.sera.tech/admins/memberships");
    await page.waitForTimeout(3000);

    const rows = await waitForRows(page, 10000);
    console.log("[3] Rows found: " + rows.length);

    for (const row of rows) {
      console.log(`Processing: ${row.customer} / ${row.program} / ${row.soldOn}`);

      // ── Open modal ──────────────
      try {
        const clickResult = await openMembershipModal(stagehand, page, row.customer, row.soldOn, row.program);
        console.log("  Modal click: " + clickResult);

        const modalOpen = await waitForModal(page, 8000);
        if (!modalOpen) throw new Error("Modal did not open");

        // ── Fill Dates ─────────────
        const variant = getModalVariant(row.program);
        const startsOnVal = await typeDate(page, "Starts On", row.soldOnShort);
        const secondDateVal = await typeDate(page, variant === "ends-on" ? "Ends On" : "Next Billing Date", calcSecondDate(row.soldOnShort, row.program));

        // ── Save & Complete ────────
        const saveResult = await clickSave(page);
        console.log("  Save: " + saveResult);

        const modalClosed = await waitForModalClose(page, 10000);
        if (!modalClosed) throw new Error("Modal did not close");

        const removed = await waitForRowRemoval(page, row.soldOn, row.customer, 120000, 3000);
        if (!removed) throw new Error("Row still present after save");

        processed.push({
          customer: row.customer, job: row.job, program: row.program,
          soldOn: row.soldOn, startsOn: startsOnVal,
          secondDateField: variant, secondDateValue: secondDateVal,
          message: "Saved OK"
        });
        console.log("  ✅ Row processed successfully");

      } catch (err: unknown) {
        failed.push({ customer: row.customer, job: row.job, program: row.program, soldOn: row.soldOn, rowIndex: row.rowIndex, message: err instanceof Error ? err.message : String(err) });
        console.log("  ❌ Failed: " + (err instanceof Error ? err.message : String(err)));
      }
    }

  } catch (e: unknown) {
    console.log("Fatal error: " + (e instanceof Error ? e.message : String(e)));
  }

  const elapsedMinutes = Math.round((Date.now() - t0) / 60000);

  return {
    success: failed.length === 0,
    message: "Task finished",
    processedCount: processed.length,
    failedCount: failed.length,
    processed, failed,
    elapsedMinutes, sessionUrl
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.post("/run-membership-task", async (_req: Request, res: Response) => {
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Active Membership server running on port " + port));
