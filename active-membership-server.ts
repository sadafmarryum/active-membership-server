// active-membership-server.ts
// Stagehand v3 — Mister Quik membership date fixer
//
// Flow (from screenshots):
//   1. Login to SERA
//   2. Navigate to /memberships
//   3. For each row: click the PROGRAM column link (blue text, e.g. "Shape Plan Auto-Renew")
//   4. Modal opens → set Starts On = Sold On date, set Next Billing Date (or Ends On)
//   5. Click Save & Complete → wait for modal to close
//
// Date format in modal: MM/DD/YY (2-digit year, as shown in screenshot)
// Sold On column format: MM/DD/YYYY (4-digit year) → convert to MM/DD/YY for modal

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage        = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing" | "unknown";

interface MembershipRow {
  soldOn: string;      // MM/DD/YYYY from table
  soldOnShort: string; // MM/DD/YY for modal input
  invoice: string;
  job: string;
  customer: string;
  program: string;
  rowIndex: number;
}

interface ProcessedEntry {
  customer: string; job: string; program: string;
  soldOn: string; startsOn: string;
  secondDateField: string; secondDateValue: string;
  message: string;
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

/** Convert MM/DD/YYYY → MM/DD/YY (modal uses 2-digit year) */
function toShortYear(date: string): string {
  const parts = date.split("/");
  if (parts.length !== 3 || (parts[2] || "").length !== 4) return date;
  return parts[0] + "/" + parts[1] + "/" + parts[2].substring(2);
}

function getModalVariant(program: string): ModalVariant {
  const n = program.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

/** Calculate second date (Ends On / Next Billing Date) in MM/DD/YY format */
function calcSecondDate(soldOnShort: string, program: string): string {
  const parts = soldOnShort.split("/");
  if (parts.length !== 3) return soldOnShort;
  const [m, d, yy] = parts;
  const year = parseInt(yy, 10) + 2000; // YY → YYYY
  const n = program.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  const newYY = String((year + add) % 100).padStart(2, "0");
  return m + "/" + d + "/" + newYY;
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
        const soldOn = (c[0] && c[0].textContent ? c[0].textContent.trim() : "");
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        // MM/DD/YYYY → MM/DD/YY
        const parts = soldOn.split("/");
        const soldOnShort = parts[0] + "/" + parts[1] + "/" + (parts[2] ? parts[2].substring(2) : "");
        out.push({
          soldOn,
          soldOnShort,
          invoice:  (c[1] && c[1].textContent ? c[1].textContent.trim() : ""),
          job:      (c[2] && c[2].textContent ? c[2].textContent.trim() : ""),
          customer: (c[3] && c[3].textContent ? c[3].textContent.trim() : ""),
          program:  (c[4] && c[4].textContent ? c[4].textContent.trim() : ""),
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
 * Click the PROGRAM column link for the target row.
 * From the screenshot: program names like "Shape Plan Auto-Renew" are blue
 * underlined links in the PROGRAM column (column index 4).
 * We find the row by soldOn + customer match, then click the <a> in td[4].
 */
async function clickProgramLink(
  page: SPage,
  soldOn: string,
  customer: string,
  program: string,
  rowIndex: number
): Promise<{ clicked: boolean; detail: string }> {
  return page.evaluate(
    function(args: { soldOn: string; customer: string; program: string; rowIndex: number }): { clicked: boolean; detail: string } {
      const allRows = Array.from(document.querySelectorAll("table tbody tr"));

      // Find the row matching soldOn + customer
      let targetRow: Element | null = null;
      for (let i = 0; i < allRows.length; i++) {
        const r = allRows[i];
        if (!r) continue;
        const cells = Array.from(r.querySelectorAll("td"));
        const soldOnCell    = cells[0] ? (cells[0].textContent || "").trim() : "";
        const customerCell  = cells[3] ? (cells[3].textContent || "").trim() : "";
        if (soldOnCell === args.soldOn && customerCell === args.customer) {
          targetRow = r;
          break;
        }
      }

      // Fallback: use rowIndex
      if (!targetRow) targetRow = allRows[args.rowIndex] || null;
      if (!targetRow) return { clicked: false, detail: "no row found" };

      const cells = Array.from(targetRow.querySelectorAll("td"));

      // The PROGRAM column is td[4].
      // The program text is NOT a plain <a> tag — it is rendered by an Angular/web component.
      // The click handler is on the <td> element itself (or a child span/div).
      const programCell = cells[4];
      if (programCell) {
        // Try clicking a child element first (span, div, or any non-<a> clickable)
        const child = programCell.querySelector<HTMLElement>("span,div,[class],[role=button]");
        if (child) {
          child.click();
          return { clicked: true, detail: "td[4] child click: " + child.tagName + " text=" + (child.textContent || "").trim().substring(0, 30) };
        }
        // Click the <td> cell directly
        (programCell as HTMLElement).click();
        return { clicked: true, detail: "td[4] direct click: text=" + (programCell.textContent || "").trim().substring(0, 30) };
      }

      return { clicked: false, detail: "td[4] not found. cells=" + cells.length };
    },
    { soldOn, customer, program, rowIndex }
  );
}

async function waitForModal(page: SPage, ms = 7000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open: boolean = await page.evaluate((): boolean => {
      // Check for visible modal dialog
      const dialog = document.querySelector<HTMLElement>('.modal.show,[role="dialog"]');
      if (dialog && dialog.offsetParent !== null) return true;
      // Check sera-modal shadow root
      const sm = document.querySelector("sera-modal");
      if (sm && sm.shadowRoot && sm.shadowRoot.childElementCount > 0) return true;
      // Check for "Edit Memberships" heading
      return Array.from(document.querySelectorAll<HTMLElement>("h4,h5,.modal-title"))
        .some(function(h) {
          return (h.textContent || "").includes("Edit Memberships") && h.offsetParent !== null;
        });
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
      const dialog = document.querySelector<HTMLElement>('.modal.show,[role="dialog"]');
      if (dialog && dialog.offsetParent !== null) return true;
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

/**
 * Type a date into a modal date input identified by its label.
 * Uses triple-click + Input.insertText to replace the existing value.
 * Modal date format: MM/DD/YY (2-digit year).
 */
async function typeDate(page: SPage, labelText: string, dateValue: string): Promise<string> {
  const inputId: string = await page.evaluate(
    function(args: { label: string; stamp: string }): string {
      function findInput(root: Document | ShadowRoot): HTMLInputElement | null {
        const labels = Array.from(root.querySelectorAll<HTMLLabelElement>("label"));
        const lbl = labels.find(function(l) {
          return (l.textContent || "").trim().toLowerCase() === args.label.toLowerCase();
        });
        if (!lbl) return null;
        const forId = lbl.getAttribute("for");
        if (forId) {
          const el = (root as Document).getElementById
            ? (root as Document).getElementById(forId)
            : null;
          if (el) return el as HTMLInputElement;
        }
        let sib = lbl.nextElementSibling;
        while (sib) {
          if (sib.tagName === "INPUT") return sib as HTMLInputElement;
          const inp = sib.querySelector<HTMLInputElement>("input");
          if (inp) return inp;
          sib = sib.nextElementSibling;
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
    { label: labelText, stamp: "__date_" + labelText.replace(/\W/g, "") }
  );

  if (!inputId) throw new Error("Label not found: " + labelText);

  // Triple-click to select all, then type
  const loc = page.locator("#" + inputId).first();
  await loc.click({ clickCount: 3 });
  await page.waitForTimeout(150);

  // Ctrl+A to make sure everything is selected
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp",   key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.waitForTimeout(100);

  // Type the date value
  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(200);

  // Tab to commit
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.waitForTimeout(300);

  // Return actual value for verification
  const actual: string = await page.evaluate(function(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) return el.value;
    // Also check shadow root
    const sm = document.querySelector("sera-modal");
    if (sm && sm.shadowRoot) {
      const sel = sm.shadowRoot.getElementById(id) as HTMLInputElement | null;
      if (sel) return sel.value;
    }
    return "";
  }, inputId);

  return actual;
}

/**
 * Click Save & Complete button.
 * Tries: stagehand.act() → CDP mouse click via getBoundingClientRect → composed JS click.
 */
async function clickSave(stagehand: V3, page: SPage): Promise<string> {
  // Strategy 1: stagehand.act()
  try {
    await stagehand.act("Click the blue Save & Complete button in the open modal");
    return "act()";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.log("  act() failed: " + msg.substring(0, 80));
  }

  // Strategy 2: CDP mouse via getBoundingClientRect (works across shadow DOM)
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
            if (!btn && (el as HTMLElement).shadowRoot) {
              btn = findBtn((el as HTMLElement).shadowRoot as ShadowRoot);
            }
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

  // Strategy 3: composed MouseEvent
  const jsOk: boolean = await page.evaluate((): boolean => {
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

  if (!jsOk) throw new Error("Save & Complete button not found");
  return "composed-MouseEvent";
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

    // ── Login ──────────────────────────────────────────────────────────
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

    // ── Navigate to memberships & scan rows ────────────────────────────
    console.log("[2] /memberships");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const allRows = await waitForRows(page);
    console.log("  " + allRows.length + " row(s) found:");
    allRows.forEach(function(r, i) {
      console.log("  [" + (i + 1) + "] " + r.soldOn + " | " + r.customer + " | " + r.program);
    });

    if (allRows.length === 0) {
      return {
        success: true, message: "No membership rows found.",
        processedCount: 0, failedCount: 0, processed: [], failed: [],
        elapsedMinutes: parseFloat(((Date.now() - t0) / 60000).toFixed(2)), sessionUrl,
      };
    }

    // ── Process each row ───────────────────────────────────────────────
    for (let i = 0; i < allRows.length; i++) {
      const row    = allRows[i];
      const expVar = getModalVariant(row.program);
      const date2  = calcSecondDate(row.soldOnShort, row.program);

      console.log("[3." + (i + 1) + "] " + row.customer + " | " + row.program);
      console.log("  soldOn=" + row.soldOn + " short=" + row.soldOnShort + " -> " + (expVar === "ends-on" ? "Ends On" : "Next Billing") + ": " + date2);

      // Fresh page load for each row
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(2000);

      const tableRows = await waitForRows(page, 8000);
      if (tableRows.length === 0) {
        failed.push({ ...row, message: "Table empty after reload" }); continue;
      }

      // Click PROGRAM column link
      console.log("  Clicking program link: \"" + row.program + "\"");
      const clickResult = await clickProgramLink(page, row.soldOn, row.customer, row.program, row.rowIndex);
      console.log("  Click result: clicked=" + clickResult.clicked + " | " + clickResult.detail);

      if (!clickResult.clicked) {
        failed.push({ ...row, message: "Program link not clicked: " + clickResult.detail }); continue;
      }

      // Wait for Edit Memberships modal
      const modalOpen = await waitForModal(page, 7000);
      if (!modalOpen) {
        const pageState: string = await page.evaluate((): string => {
          return window.location.href;
        });
        console.log("  Modal not open. Current URL: " + pageState);
        failed.push({ ...row, message: "Modal did not open (URL: " + pageState + ")" }); continue;
      }
      console.log("  Modal open");
      await page.waitForTimeout(700);

      // Detect which second-date field is shown
      const variant  = await detectVariant(page);
      const useVar   = variant !== "unknown" ? variant : expVar;
      const field2   = useVar === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log("  Variant: " + field2);

      // Set Starts On = soldOnShort (MM/DD/YY)
      console.log("  Setting Starts On -> " + row.soldOnShort);
      let startsSet = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const val = await typeDate(page, "Starts On", row.soldOnShort);
          console.log("  Starts On attempt " + attempt + " -> value=\"" + val + "\"");
          startsSet = true;
          break;
        } catch (e: unknown) {
          console.log("  Starts On attempt " + attempt + " error: " + (e instanceof Error ? e.message : String(e)));
          await page.waitForTimeout(500);
        }
      }
      if (!startsSet) console.log("  WARNING: Starts On not confirmed");

      // Set second date field
      console.log("  Setting \"" + field2 + "\" -> " + date2);
      try {
        const val2 = await typeDate(page, field2, date2);
        console.log("  \"" + field2 + "\" -> value=\"" + val2 + "\"");
      } catch (e: unknown) {
        console.log("  \"" + field2 + "\" error: " + (e instanceof Error ? e.message : String(e)));
      }

      await page.waitForTimeout(500);

      // Save & Complete
      console.log("  Saving...");
      try {
        const saveMethod = await clickSave(stagehand, page);
        console.log("  Save clicked via: " + saveMethod);

        const closed = await waitForModalClose(page, 10000);
        if (!closed) {
          failed.push({ ...row, message: "Save clicked but modal did not close" }); continue;
        }

        console.log("  SAVED OK (modal closed)");
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
      lines.push((success ? "\u2705" : "") + " Processed " + processed.length + " membership(s):");
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
