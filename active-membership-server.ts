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

/**
 * Use a REAL CDP mouse click on the program cell (td[4]) to open the modal.
 * IMPORTANT: Rows shift after each processed entry disappears from the table.
 * We ALWAYS find the row fresh by customer name — never use stored rowIndex.
 */
async function clickProgramCellByCustomer(page: SPage, customer: string, soldOn: string): Promise<string> {
  const coords: { x: number; y: number; found: boolean; debug: string } = await page.evaluate(
    function(args: { customer: string; soldOn: string }): { x: number; y: number; found: boolean; debug: string } {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      let targetRow: Element | null = null;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const cells = r.querySelectorAll("td");
        const rowSoldOn   = (cells[0] ? cells[0].textContent || "" : "").trim();
        const rowCustomer = (cells[3] ? cells[3].textContent || "" : "").trim();
        if (rowSoldOn === args.soldOn && rowCustomer === args.customer) {
          targetRow = r;
          break;
        }
      }

      if (!targetRow) {
        return { x: 0, y: 0, found: false, debug: "customer not found: " + args.customer + " | rows=" + rows.length };
      }

      const cells = targetRow.querySelectorAll("td");
      const cell = cells[4] as HTMLElement | undefined;
      if (!cell) return { x: 0, y: 0, found: false, debug: "td[4] missing, cells=" + cells.length };

      cell.scrollIntoView({ block: "center", inline: "center" });
      const r = cell.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top  + r.height / 2),
        found: r.width > 0,
        debug: "td[4] text=" + (cell.textContent || "").trim().substring(0, 30) + " rect=" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height),
      };
    },
    { customer, soldOn }
  );

  if (!coords.found) return "NOT FOUND: " + coords.debug;

  const { x, y } = coords;
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",    x, y, button: "none" });
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(80);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });

  return "CDP click at (" + x + "," + y + ") | " + coords.debug;
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

async function clickSave(stagehand: V3, page: SPage): Promise<string> {
  // Strategy 1: stagehand.act()
  try {
    await stagehand.act("Click the blue Save & Complete button in the open modal");
    return "act()";
  } catch (e: unknown) {
    console.log("  act() failed: " + (e instanceof Error ? e.message.split("\n")[0].substring(0, 80) : String(e)));
  }

  // Strategy 2: CDP mouse via getBoundingClientRect
  const coords: { x: number; y: number; ok: boolean } = await page.evaluate((): { x: number; y: number; ok: boolean } => {
    function findBtn(root: Document | ShadowRoot): HTMLElement | null {
      return Array.from(root.querySelectorAll<HTMLElement>("button,input[type=submit],[role=button]"))
        .find(function(el) {
          const t = (el.textContent || "").trim().toLowerCase();
          return t === "save & complete" || t === "save and complete";
        }) || null;
    }
    let btn = findBtn(document);
    if (!btn) {
      const sm = document.querySelector("sera-modal");
      if (sm && sm.shadowRoot) {
        btn = findBtn(sm.shadowRoot);
        if (!btn) {
          Array.from(sm.shadowRoot.querySelectorAll("*")).forEach(function(el) {
            if (!btn && (el as HTMLElement).shadowRoot) btn = findBtn((el as HTMLElement).shadowRoot as ShadowRoot);
          });
        }
      }
    }
    if (!btn) return { x: 0, y: 0, ok: false };
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 0 };
  });

  if (coords.ok) {
    const { x, y } = coords;
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",    x, y, button: "none" });
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1 });
    await page.waitForTimeout(80);
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return "CDP-mouse(" + x + "," + y + ")";
  }

  // Strategy 3: composed JS click
  const ok: boolean = await page.evaluate((): boolean => {
    function findBtn(root: Document | ShadowRoot): HTMLElement | null {
      return Array.from(root.querySelectorAll<HTMLElement>("button,[role=button]"))
        .find(function(el) {
          const t = (el.textContent || "").trim().toLowerCase();
          return t === "save & complete" || t === "save and complete";
        }) || null;
    }
    let btn = findBtn(document);
    const sm = document.querySelector("sera-modal");
    if (!btn && sm && sm.shadowRoot) btn = findBtn(sm.shadowRoot);
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    return true;
  });

  if (!ok) throw new Error("Save & Complete button not found");
  return "composed-click";
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
            return t === "sign in" || t === "login" || t === "log in" || v === "sign in" || v === "login";
          });
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) await page.locator("button[type=submit]").first().click();
      let ok = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes("/login")) { ok = true; break; }
      }
      if (!ok) throw new Error("Login failed");
      console.log("  Logged in");
    } else {
      console.log("  Already logged in");
    }

    // ── Step 2: Go to /memberships ONCE and read all rows ──────────────
    console.log("[2] Navigate to /memberships");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const allRows = await waitForRows(page);
    console.log("  Found " + allRows.length + " row(s):");
    allRows.forEach(function(r, i) {
      console.log("  [" + (i + 1) + "] " + r.soldOn + " | " + r.customer + " | " + r.program);
    });

    if (allRows.length === 0) {
      return {
        success: true, message: "No rows found.",
        processedCount: 0, failedCount: 0, processed: [], failed: [],
        elapsedMinutes: parseFloat(((Date.now() - t0) / 60000).toFixed(2)), sessionUrl,
      };
    }

    // ── Step 3: Process each row WITHOUT reloading the page ────────────
    // After each modal closes, the table is still visible — just click the next row.
    for (let i = 0; i < allRows.length; i++) {
      const row    = allRows[i];
      const expVar = getModalVariant(row.program);
      const date2  = calcSecondDate(row.soldOnShort, row.program);

      console.log("[3." + (i + 1) + "] " + row.customer + " | " + row.program);
      console.log("  Starts On: " + row.soldOnShort + " | " + (expVar === "ends-on" ? "Ends On" : "Next Billing") + ": " + date2);

      // ── 3a. Click the program cell with a real CDP mouse event ─────
      console.log("  Clicking program cell...");
      const clickResult = await clickProgramCellByCustomer(page, row.customer, row.soldOn);
      console.log("  Click: " + clickResult);

      // ── 3b. Wait for modal to appear ───────────────────────────────
      const modalOpen = await waitForModal(page, 8000);
      if (!modalOpen) {
        console.log("  ERROR: modal did not open");
        failed.push({ ...row, message: "Modal did not open after CDP click: " + clickResult });
        continue;
      }
      console.log("  Modal open OK");
      await page.waitForTimeout(700);

      // ── 3c. Detect Ends On vs Next Billing Date ────────────────────
      const variant = await detectVariant(page);
      const useVar  = variant !== "unknown" ? variant : expVar;
      const field2  = useVar === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log("  Field: " + field2);

      // ── 3d. Type Starts On ─────────────────────────────────────────
      console.log("  Starts On -> " + row.soldOnShort);
      for (let a = 1; a <= 3; a++) {
        try {
          const val = await typeDate(page, "Starts On", row.soldOnShort);
          console.log("  Starts On set, field value: \"" + val + "\"");
          break;
        } catch (e: unknown) {
          console.log("  Starts On attempt " + a + " failed: " + (e instanceof Error ? e.message : String(e)));
          await page.waitForTimeout(500);
        }
      }

      // ── 3e. Type second date ───────────────────────────────────────
      console.log("  " + field2 + " -> " + date2);
      try {
        const val2 = await typeDate(page, field2, date2);
        console.log("  " + field2 + " set, field value: \"" + val2 + "\"");
      } catch (e: unknown) {
        console.log("  " + field2 + " failed: " + (e instanceof Error ? e.message : String(e)));
      }

      await page.waitForTimeout(500);

      // ── 3f. Click Save & Complete ──────────────────────────────────
      console.log("  Saving...");
      try {
        const saveMethod = await clickSave(stagehand, page);
        console.log("  Save via: " + saveMethod);

        const closed = await waitForModalClose(page, 10000);
        if (!closed) {
          failed.push({ ...row, message: "Modal did not close after save" });
          console.log("  ERROR: modal did not close");
          // Close modal manually so we can continue with next row
          await page.evaluate((): void => {
            const x = document.querySelector<HTMLElement>('.modal .close,[data-dismiss="modal"],[aria-label="Close"]');
            if (x) x.click();
            const sm = document.querySelector("sera-modal");
            if (sm && sm.shadowRoot) {
              const xBtn = sm.shadowRoot.querySelector<HTMLElement>(".close,[aria-label=Close],button.close");
              if (xBtn) xBtn.click();
            }
          });
          await page.waitForTimeout(1000);
          continue;
        }

        console.log("  SAVED OK");
        processed.push({
          customer: row.customer, job: row.job, program: row.program,
          soldOn: row.soldOn, startsOn: row.soldOnShort,
          secondDateField: field2, secondDateValue: date2,
          message: row.customer + " | Job #" + row.job + " | " + row.program +
                   " | Starts On: " + row.soldOnShort + " | " + field2 + ": " + date2,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ ...row, message: "Save failed: " + msg });
        console.log("  Save error: " + msg);
      }

      // Small pause between rows
      await page.waitForTimeout(500);
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Fatal: " + msg);
    failed.push({ message: "Fatal: " + msg });
  } finally {
    await stagehand.close();
    console.log("Session closed");
  }

  const elapsed = ((Date.now() - t0) / 60000).toFixed(2);
  const success = failed.length === 0;
  let message: string;
  if (!processed.length && !failed.length) {
    message = "Nothing to process.";
  } else {
    const lines: string[] = [];
    if (processed.length) {
      lines.push("\u2705 Processed " + processed.length + " membership(s):");
      processed.forEach(function(p) { lines.push("   - " + p.message); });
    }
    if (failed.length) {
      lines.push("\u274C Failed " + failed.length + " membership(s):");
      failed.forEach(function(f) { lines.push("   - " + (f.customer || "unknown") + " | " + f.message); });
    }
    message = lines.join("\n");
  }

  return {
    success, message,
    processedCount: processed.length, failedCount: failed.length,
    processed, failed,
    elapsedMinutes: parseFloat(elapsed), sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.get("/health", function(_req: Request, res: Response): void {
  res.json({ status: "ok", service: "active-membership-server" });
});

app.post("/run-membership-fix", async function(_req: Request, res: Response): Promise<void> {
  console.log("[" + new Date().toISOString() + "] POST /run-membership-fix");
  try {
    res.json(await runMembershipTask());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: "Server error: " + msg });
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, function() {
  console.log("Active Membership Server on port " + PORT);
});
