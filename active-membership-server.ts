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
 * Open the Edit Memberships modal for a specific customer row.
 * Uses stagehand.act() as primary — the AI sees the rendered page and clicks
 * the correct element regardless of DOM structure.
 * Falls back to direct CDP coordinate click on the program cell.
 */
async function openMembershipModal(
  stagehand: V3,
  page: SPage,
  customer: string,
  soldOn: string,
  program: string
): Promise<string> {
  // The program text is inside <span class="link"> inside td[4].
  // Stamp that span with a unique ID, then use locator.click() which fires
  // real CDP pointer events — exactly what Angular's (click) handler needs.
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
          // Target the <span class="link"> specifically
          const span = td.querySelector<HTMLElement>("span.link");
          if (span) { span.id = args.stamp; return args.stamp; }
          // Fallback: any span inside td[4]
          const anySpan = td.querySelector<HTMLElement>("span");
          if (anySpan) { anySpan.id = args.stamp; return args.stamp; }
          // Fallback: stamp the td itself
          td.id = args.stamp;
          return args.stamp;
        }
      }
      return "";
    },
    { customer, soldOn, stamp: "__sp_" + Date.now() }
  );

  if (!spanId) return "NOT FOUND: no matching row for " + customer;

  // locator.click() resolves the element and fires real mousedown/mouseup CDP events
  try {
    await page.locator("#" + spanId).first().click();
    return "locator span.link click";
  } catch (e: unknown) {
    console.log("  locator span click failed: " + (e instanceof Error ? e.message.split("\n")[0].substring(0, 60) : String(e)));
  }

  // Fallback: CDP mouse coordinates on the span
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
  // Target: <span data-v-c7226b75="">Save & Complete</span>  (Vue scoped component)
  // Strategy: find via selector, get real viewport coords, fire CDP mouse events.
  // We do NOT use locator.click() or JS .click() — Vue's event system needs
  // real pointer events dispatched at the correct screen coordinates.

  const coords: { x: number; y: number; found: boolean; debug: string } = await page.evaluate((): { x: number; y: number; found: boolean; debug: string } => {
    // Find the span[data-v-c7226b75] that contains "Save" text
    function findSpan(root: Document | ShadowRoot): HTMLElement | null {
      // Exact match: span with data-v-c7226b75 attribute
      const byAttr = Array.from(root.querySelectorAll<HTMLElement>("span[data-v-c7226b75]"))
        .find(function(el) {
          return (el.textContent || "").trim().toLowerCase().includes("save");
        });
      if (byAttr) return byAttr;

      // Fallback: button containing a span with Save text
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

  // Fire the full real mouse event sequence at the button coordinates
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

    // DIAGNOSTIC: dump td[4] innerHTML for first 3 rows to see exact DOM structure
    const diagDump: string = await page.evaluate((): string => {
      const rows = Array.from(document.querySelectorAll("table tbody tr")).slice(0, 3);
      return rows.map(function(r, i) {
        const cells = r.querySelectorAll("td");
        const td4 = cells[4] as HTMLElement | undefined;
        return "row[" + i + "] customer=" + (cells[3] ? (cells[3].textContent || "").trim() : "?") +
               " | td[4] innerHTML=" + (td4 ? td4.innerHTML.substring(0, 300) : "MISSING");
      }).join("\n---\n");
    });
    console.log("\nTABLE td[4] STRUCTURE:\n" + diagDump + "\n");

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
      const clickResult = await openMembershipModal(stagehand, page, row.customer, row.soldOn, row.program);
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

      // DIAGNOSTIC: dump modal button HTML so we can see exact Save button structure
      const modalDiag: string = await page.evaluate((): string => {
        const parts: string[] = [];
        // Check main DOM buttons
        const btns = Array.from(document.querySelectorAll("button"));
        parts.push("main-buttons: " + btns.map(function(b) {
          return "[" + (b.textContent || "").trim().substring(0, 30) + "] class=" + b.className;
        }).join(" | "));
        // Check sera-modal shadow root
        const sm = document.querySelector("sera-modal");
        if (sm && sm.shadowRoot) {
          const shadowBtns = Array.from(sm.shadowRoot.querySelectorAll("button"));
          parts.push("shadow-buttons: " + shadowBtns.map(function(b) {
            return "[" + (b.textContent || "").trim().substring(0, 30) + "] class=" + b.className;
          }).join(" | "));
          // Also dump the bottom of the modal HTML to see button structure
          const modalEl = sm.shadowRoot.querySelector(".modal-footer,.modal-body") as HTMLElement | null;
          if (modalEl) parts.push("modal-footer-html: " + modalEl.innerHTML.substring(0, 400));
        }
        return parts.join("\n");
      });
      if (i === 0) console.log("MODAL BUTTON STRUCTURE:\n" + modalDiag);

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
        const saveMethod = await clickSave(page);
        console.log("  Save via: " + saveMethod);

        // Wait for modal to close
        const closed = await waitForModalClose(page, 10000);
        if (!closed) {
          failed.push({ ...row, message: "Modal did not close after save" });
          console.log("  ERROR: modal did not close");
          await page.evaluate((): void => {
            const sm = document.querySelector("sera-modal");
            if (sm && sm.shadowRoot) {
              const xBtn = sm.shadowRoot.querySelector<HTMLElement>("[aria-label=Close],[aria-label=close],.close");
              if (xBtn) xBtn.click();
            }
          });
          await page.waitForTimeout(1000);
          continue;
        }

        // Verify save actually worked: the row should no longer be in the table
        await page.waitForTimeout(500);
        const rowStillPresent: boolean = await page.evaluate(
          function(args: { soldOn: string; customer: string }): boolean {
            const rows = Array.from(document.querySelectorAll("table tbody tr"));
            return rows.some(function(r) {
              const cells = r.querySelectorAll("td");
              const s = (cells[0] ? cells[0].textContent || "" : "").trim();
              const c = (cells[3] ? cells[3].textContent || "" : "").trim();
              return s === args.soldOn && c === args.customer;
            });
          },
          { soldOn: row.soldOn, customer: row.customer }
        );

        if (rowStillPresent) {
          // Modal closed but row is still in table — save didn't work
          failed.push({ ...row, message: "Modal closed but row still in table — save did not persist" });
          console.log("  ERROR: row still in table after save");
          continue;
        }

        console.log("  SAVED OK - row removed from table");
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
