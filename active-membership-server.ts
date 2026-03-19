// active-membership-server.ts
// Express server + Stagehand v3 browser automation
//
// KEY FIX in this version:
//   "Save & Complete" now uses a real CDP mouse click (scroll into view →
//   get bounding box → Input.dispatchMouseEvent) instead of a JS .click()
//   DOM event. This is required because SERA's button is inside a sera-modal
//   web component shadow root and only responds to real pointer events.
//
//   After clicking Save, we verify success by waiting for the modal to close.
//
// Modal variants:
//   10-Year / 5-Year plans  →  Starts On  +  Ends On
//   Auto-Renew / other      →  Starts On  +  Next Billing Date

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

// =============================================================================
// TYPES
// =============================================================================

type SPage        = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing" | "unknown";

interface MembershipRow {
  soldOn: string;
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

// CDP types for box model response
interface CdpBoxModel {
  model: {
    content: number[];
    padding: number[];
    border: number[];
    margin: number[];
    width: number;
    height: number;
  };
}

interface CdpResolveNode {
  object: { objectId: string };
}

interface CdpRequestNode {
  nodeId: number;
}

interface CdpDescribeNode {
  node: { backendNodeId: number };
}

// =============================================================================
// DATE HELPERS
// =============================================================================

function getModalVariant(programName: string): ModalVariant {
  const n = programName.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

function calcSecondDate(soldOn: string, programName: string): string {
  const parts = soldOn.split("/");
  if (parts.length !== 3) return soldOn;
  const [month, day, yearStr] = parts;
  const year = parseInt(yearStr, 10);
  const n    = programName.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  return `${month}/${day}/${year + add}`;
}

// =============================================================================
// PAGE HELPERS
// =============================================================================

async function waitForTableRows(page: SPage, maxWaitMs = 10000): Promise<MembershipRow[]> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const rows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const result: MembershipRow[] = [];
      document.querySelectorAll("table tbody tr").forEach((row, idx) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;
        const soldOn   = cells[0]?.textContent?.trim() ?? "";
        const invoice  = cells[1]?.textContent?.trim() ?? "";
        const job      = cells[2]?.textContent?.trim() ?? "";
        const customer = cells[3]?.textContent?.trim() ?? "";
        const program  = cells[4]?.textContent?.trim() ?? "";
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        if (soldOn.includes("#") || program.includes("#")) return;
        result.push({ soldOn, invoice, job, customer, program, rowIndex: idx });
      });
      return result;
    });
    if (rows.length > 0) return rows;
    await page.waitForTimeout(500);
  }
  return [];
}

async function clickProgramLink(page: SPage, programName: string): Promise<boolean> {
  // Primary: text= selector (triggers Stagehand shadow-DOM pierce fallback)
  try {
    const loc = page.locator(`text=${programName}`).first();
    const visible = await loc.isVisible().catch(() => false);
    if (visible) { await loc.click(); return true; }
  } catch { /* fall through */ }

  // Fallback: DOM evaluate
  return page.evaluate((target: string): boolean => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
    const exact = links.find(
      (a) => a.textContent?.trim().toLowerCase() === target.toLowerCase() && a.offsetParent !== null
    );
    if (exact) { exact.click(); return true; }
    const partial = links.find(
      (a) =>
        a.textContent?.trim().toLowerCase().startsWith(target.toLowerCase().substring(0, 12)) &&
        a.offsetParent !== null && !/^\d+$/.test(a.textContent?.trim() ?? "")
    );
    if (partial) { partial.click(); return true; }
    return false;
  }, programName);
}

async function waitForModal(page: SPage, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open: boolean = await page.evaluate((): boolean => {
      const standard = document.querySelector<HTMLElement>(
        '.modal[style*="display: block"], .modal.show, [role="dialog"]'
      );
      if (standard && standard.offsetParent !== null) return true;
      const seraModal = document.querySelector("sera-modal");
      if (seraModal?.shadowRoot && seraModal.shadowRoot.childElementCount > 0) return true;
      return Array.from(document.querySelectorAll<HTMLElement>("h5, h4, .modal-title")).some(
        (h) => h.textContent?.includes("Edit Memberships") && h.offsetParent !== null
      );
    });
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** Wait for the modal to CLOSE (row saved → modal dismissed) */
async function waitForModalClose(page: SPage, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillOpen: boolean = await page.evaluate((): boolean => {
      const seraModal = document.querySelector("sera-modal");
      if (seraModal?.shadowRoot && seraModal.shadowRoot.childElementCount > 0) return true;
      const standard = document.querySelector<HTMLElement>(
        '.modal[style*="display: block"], .modal.show, [role="dialog"]'
      );
      if (standard && standard.offsetParent !== null) return true;
      return Array.from(document.querySelectorAll<HTMLElement>("h5, h4, .modal-title")).some(
        (h) => h.textContent?.includes("Edit Memberships") && h.offsetParent !== null
      );
    });
    if (!stillOpen) return true; // modal closed = save succeeded
    await page.waitForTimeout(300);
  }
  return false; // timed out — modal never closed
}

async function detectModalVariant(page: SPage): Promise<ModalVariant> {
  return page.evaluate((): ModalVariant => {
    const mainText = document.body.innerText.toLowerCase();
    if (mainText.includes("ends on"))      return "ends-on";
    if (mainText.includes("next billing")) return "next-billing";
    const seraModal = document.querySelector("sera-modal");
    if (seraModal?.shadowRoot) {
      const shadow = seraModal.shadowRoot.textContent?.toLowerCase() ?? "";
      if (shadow.includes("ends on"))      return "ends-on";
      if (shadow.includes("next billing")) return "next-billing";
    }
    return "unknown";
  });
}

async function fillDateByLabel(page: SPage, labelText: string, dateValue: string): Promise<void> {
  const inputId: string = await page.evaluate(
    (args: { label: string; id: string }): string => {
      const { label, id } = args;

      const findInputForLabel = (lbl: HTMLLabelElement): HTMLInputElement | null => {
        const forAttr = lbl.getAttribute("for");
        if (forAttr) {
          const el = document.getElementById(forAttr) as HTMLInputElement | null;
          if (el) return el;
        }
        let next = lbl.nextElementSibling;
        while (next) {
          if ((next as HTMLInputElement).tagName === "INPUT") return next as HTMLInputElement;
          const inp = next.querySelector<HTMLInputElement>("input");
          if (inp) return inp;
          next = next.nextElementSibling;
        }
        return lbl.querySelector<HTMLInputElement>("input");
      };

      const searchRoot = (root: Document | ShadowRoot): HTMLInputElement | null => {
        const lbl = Array.from(root.querySelectorAll<HTMLLabelElement>("label")).find(
          (el) => el.textContent?.trim().toLowerCase() === label.toLowerCase()
        );
        return lbl ? findInputForLabel(lbl) : null;
      };

      let inp = searchRoot(document);
      if (!inp) {
        const sm = document.querySelector("sera-modal");
        if (sm?.shadowRoot) inp = searchRoot(sm.shadowRoot);
      }
      if (!inp) return "";

      inp.id = inp.id || id;
      return inp.id;
    },
    { label: labelText, id: `__sh_${labelText.replace(/\s+/g, "_").toLowerCase()}_${Date.now()}` }
  );

  if (!inputId) throw new Error(`Input not found for label "${labelText}"`);

  const loc = page.locator(`#${inputId}`).first();
  await loc.click({ clickCount: 3 });
  await page.waitForTimeout(150);
  await loc.fill(dateValue);
  await page.waitForTimeout(200);

  // Fire change/blur so the framework registers the new value
  await page.evaluate((id: string): void => {
    const el = document.getElementById(id);
    if (el) {
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
    }
  }, inputId);

  await page.waitForTimeout(200);
}

/**
 * Click "Save & Complete" using a real CDP mouse event.
 *
 * Why: SERA's button lives inside a sera-modal shadow root. JS .click() dispatches
 * a synthetic DOM event which many modern frameworks (Angular, web components) ignore
 * for form submission. We need the same path as a real user click:
 *   1. Resolve button objectId via Runtime.evaluate (works in shadow DOM)
 *   2. DOM.scrollIntoViewIfNeeded  →  scroll button into viewport
 *   3. DOM.getBoxModel             →  get pixel coordinates
 *   4. Input.dispatchMouseEvent    →  fire real mousemove + mousedown + mouseup + click
 */
async function clickSaveAndComplete(page: SPage): Promise<void> {
  // Step 1: Resolve the button's remote objectId from shadow DOM
  const objectId: string = await page.evaluate((): string => {
    const findBtn = (root: Document | ShadowRoot): HTMLElement | null => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(
        "button, input[type='submit'], [role='button']"
      ))) {
        const txt = el.textContent?.trim().toLowerCase() ?? "";
        if (txt === "save & complete" || txt === "save and complete") return el;
      }
      return null;
    };

    // Try main DOM
    let btn = findBtn(document);

    // Try sera-modal shadow root (and one level deeper)
    if (!btn) {
      const sm = document.querySelector("sera-modal");
      if (sm?.shadowRoot) {
        btn = findBtn(sm.shadowRoot);
        if (!btn) {
          for (const el of Array.from(sm.shadowRoot.querySelectorAll("*"))) {
            if ((el as HTMLElement).shadowRoot) {
              btn = findBtn((el as HTMLElement).shadowRoot!);
              if (btn) break;
            }
          }
        }
      }
    }

    if (!btn) return "";

    // Assign a temporary __objectId trick: tag the element so Runtime.evaluate
    // can return its remote reference. We use a data attribute as a bridge.
    const tag = `__save_${Date.now()}`;
    btn.setAttribute("data-sh-save", tag);
    return tag;
  });

  if (!objectId) {
    throw new Error("Save & Complete button not found in DOM or shadow root");
  }

  // Step 2: Use Runtime.evaluate to get the actual remote objectId for the tagged element
  const attr    = "data-sh-save";
  const sel     = "[" + attr + "=\"" + objectId + "\"]";
  const expr1   = "document.querySelector('" + sel + "')";
  const resolved = await page.sendCDP<CdpResolveNode>("Runtime.evaluate", {
    expression:    expr1,
    returnByValue: false,
  });

  // If main DOM resolution worked
  let remoteObjectId = resolved?.object?.objectId ?? "";

  // If not found in main DOM, evaluate from shadow root
  if (!remoteObjectId) {
    const expr2 =
      "(function() {" +
      "  var sm = document.querySelector('sera-modal');" +
      "  if (!sm || !sm.shadowRoot) return null;" +
      "  var el = sm.shadowRoot.querySelector('" + sel + "');" +
      "  if (el) return el;" +
      "  var children = sm.shadowRoot.querySelectorAll('*');" +
      "  for (var i = 0; i < children.length; i++) {" +
      "    if (children[i].shadowRoot) {" +
      "      var deep = children[i].shadowRoot.querySelector('" + sel + "');" +
      "      if (deep) return deep;" +
      "    }" +
      "  }" +
      "  return null;" +
      "})()";
    const shadowResolved = await page.sendCDP<CdpResolveNode>("Runtime.evaluate", {
      expression:    expr2,
      returnByValue: false,
    });
    remoteObjectId = shadowResolved?.object?.objectId ?? "";
  }

  if (!remoteObjectId) {
    throw new Error("Could not resolve Save & Complete button remote objectId");
  }

  // Step 3: Scroll into view
  try {
    await page.sendCDP("DOM.scrollIntoViewIfNeeded", { objectId: remoteObjectId });
    await page.waitForTimeout(200);
  } catch { /* ignore scroll errors */ }

  // Step 4: Get bounding box to find center coordinates
  const boxResult = await page.sendCDP<CdpBoxModel>("DOM.getBoxModel", {
    objectId: remoteObjectId,
  });

  const content = boxResult?.model?.content;
  if (!content || content.length < 8) {
    throw new Error("Could not get bounding box for Save & Complete button");
  }

  // content is [x1,y1, x2,y2, x3,y3, x4,y4] — top-left and bottom-right corners
  const cx = Math.round((content[0] + content[2]) / 2);
  const cy = Math.round((content[1] + content[5]) / 2);

  // Step 5: Fire real CDP mouse events (mousemove → mousedown → mouseup)
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",  x: cx, y: cy, button: "none" });
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await page.waitForTimeout(80);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

  console.log(`  ℹ️  CDP mouse click fired at (${cx}, ${cy})`);

  // Clean up the data attribute
  await page.evaluate((tag: string): void => {
    const el = document.querySelector(`[data-sh-save="${tag}"]`);
    if (el) el.removeAttribute("data-sh-save");
    const sm = document.querySelector("sera-modal");
    if (sm?.shadowRoot) {
      const sel = sm.shadowRoot.querySelector(`[data-sh-save="${tag}"]`);
      if (sel) sel.removeAttribute("data-sh-save");
    }
  }, objectId).catch(() => {});
}

// =============================================================================
// MAIN TASK
// =============================================================================

async function runMembershipTask(): Promise<TaskResult> {
  const startTime = Date.now();

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY ?? "",
    },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";
  const processed: ProcessedEntry[] = [];
  const failed: FailedEntry[]       = [];

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page: SPage = stagehand.context.activePage()!;

    // ----------------------------------------------------------------
    // STEP 1 — Login
    // ----------------------------------------------------------------
    console.log("\n[1] → Logging in …");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      const email    = process.env.SERA_EMAIL    ?? "mcc@stratablue.com";
      const password = process.env.SERA_PASSWORD ?? "";

      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(400);

      const clicked: boolean = await page.evaluate((): boolean => {
        const btn = Array.from(
          document.querySelectorAll<HTMLElement>('button, input[type="submit"]')
        ).find(
          (el) =>
            ["sign in", "login", "log in"].some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && el.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!clicked) await page.locator('button[type="submit"]').first().click();

      let loggedIn = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes("/login")) { loggedIn = true; break; }
      }
      if (!loggedIn) throw new Error("Still on login page after 30 s");
      console.log("    ✅ Logged in");
    } else {
      console.log("    ✅ Already logged in");
    }

    // ----------------------------------------------------------------
    // STEP 2 — Navigate and read ALL rows ONCE
    // ----------------------------------------------------------------
    console.log("\n[2] → Loading /memberships …");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const allRows = await waitForTableRows(page);
    console.log(`    ℹ️  Found ${allRows.length} row(s):`);
    allRows.forEach((r, i) =>
      console.log(`      [${i + 1}] ${r.soldOn} | ${r.customer} | "${r.program}" | Job #${r.job}`)
    );

    if (allRows.length === 0) {
      return {
        success: true,
        message: "No membership rows found — nothing to process.",
        processedCount: 0, failedCount: 0,
        processed: [], failed: [],
        elapsedMinutes: parseFloat(((Date.now() - startTime) / 60000).toFixed(2)),
        sessionUrl,
      };
    }

    // ----------------------------------------------------------------
    // STEP 3 — Process each row
    // ----------------------------------------------------------------
    for (let i = 0; i < allRows.length; i++) {
      const row             = allRows[i];
      const secondDate      = calcSecondDate(row.soldOn, row.program);
      const expectedVariant = getModalVariant(row.program);

      console.log(`\n[3.${i + 1}] ──────────────────────────────────────────`);
      console.log(`  Customer : ${row.customer}`);
      console.log(`  Program  : "${row.program}"`);
      console.log(`  Sold On  : ${row.soldOn}`);
      console.log(`  Expected : ${expectedVariant === "ends-on" ? "Ends On" : "Next Billing Date"} → ${secondDate}`);

      // Fresh navigation for every row
      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(2000);

      const tableRows = await waitForTableRows(page, 8000);
      if (tableRows.length === 0) {
        failed.push({ ...row, message: "Table empty after reload" });
        console.log("  ❌ Table not found — skipping");
        continue;
      }

      // ── 3a. Click program link ─────────────────────────────────────
      console.log(`  → Clicking: "${row.program}"`);
      const clicked = await clickProgramLink(page, row.program);
      if (!clicked) {
        failed.push({ ...row, message: "Program link not found" });
        console.log("  ❌ Link not found — skipping");
        continue;
      }

      // ── 3b. Wait for modal ─────────────────────────────────────────
      const modalOpen = await waitForModal(page, 6000);
      if (!modalOpen) {
        failed.push({ ...row, message: `Modal did not open. Session: ${sessionUrl}` });
        console.log("  ❌ Modal not opened — skipping");
        continue;
      }
      console.log("  ✅ Modal open");
      await page.waitForTimeout(600); // let modal fully render

      // ── 3c. Detect variant ─────────────────────────────────────────
      const actualVariant    = await detectModalVariant(page);
      const variantToUse     = actualVariant !== "unknown" ? actualVariant : expectedVariant;
      const secondFieldLabel = variantToUse === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log(`  ℹ️  Variant: "${secondFieldLabel}"`);

      // ── 3d. Set Starts On ──────────────────────────────────────────
      console.log(`  → Starts On → ${row.soldOn}`);
      let startsOnSet = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fillDateByLabel(page, "Starts On", row.soldOn);
          console.log(`  ✅ Starts On set (attempt ${attempt})`);
          startsOnSet = true;
          break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(600);
        }
      }
      if (!startsOnSet) console.log("  ⚠️  Starts On not set — continuing");

      // ── 3e. Set second date ────────────────────────────────────────
      console.log(`  → "${secondFieldLabel}" → ${secondDate}`);
      try {
        await fillDateByLabel(page, secondFieldLabel, secondDate);
        console.log(`  ✅ "${secondFieldLabel}" set`);
      } catch (e: unknown) {
        console.log(`  ⚠️  ${e instanceof Error ? e.message : e}`);
      }

      // Small pause so the app processes the date changes before we click Save
      await page.waitForTimeout(500);

      // ── 3f. Click Save & Complete (real CDP mouse event) ───────────
      console.log("  → Save & Complete (CDP mouse click) …");
      try {
        await clickSaveAndComplete(page);

        // ── 3g. VERIFY: wait for modal to close ──────────────────────
        console.log("  → Waiting for modal to close …");
        const saved = await waitForModalClose(page, 8000);

        if (!saved) {
          failed.push({ ...row, message: "Save & Complete clicked but modal did not close — save may have failed" });
          console.log("  ❌ Modal still open after 8 s — marking as failed");
          continue;
        }

        console.log("  ✅ Saved and confirmed (modal closed)");
        processed.push({
          customer: row.customer, job: row.job, program: row.program,
          soldOn: row.soldOn, startsOn: row.soldOn,
          secondDateField: secondFieldLabel, secondDateValue: secondDate,
          message:
            `${row.customer} | Job #${row.job} | ${row.program}` +
            ` | Starts On: ${row.soldOn} | ${secondFieldLabel}: ${secondDate}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ ...row, message: `Save & Complete failed: ${msg}` });
        console.log(`  ❌ ${msg}`);
      }
    }

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Fatal: ${msg}`);
    failed.push({ message: `Fatal: ${msg}` });
  } finally {
    await stagehand.close();
    console.log("\n🔒 Session closed");
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(2);
  const success = failed.length === 0;

  let message: string;
  if (processed.length === 0 && failed.length === 0) {
    message = "No memberships found to process.";
  } else {
    const lines: string[] = [];
    if (processed.length > 0) {
      lines.push(`✅ Processed ${processed.length} membership(s):`);
      processed.forEach((p) => lines.push(`   - ${p.message}`));
    }
    if (failed.length > 0) {
      lines.push(`❌ Failed ${failed.length} membership(s):`);
      failed.forEach((f) => lines.push(`   - ${f.customer ?? "unknown"} | ${f.message}`));
    }
    message = lines.join("\n");
  }

  console.log(`\n📋 Summary:\n${message}\n⏱  ${elapsed} min`);

  return {
    success, message,
    processedCount: processed.length, failedCount: failed.length,
    processed, failed,
    elapsedMinutes: parseFloat(elapsed),
    sessionUrl,
  };
}

// =============================================================================
// EXPRESS SERVER
// =============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok", service: "active-membership-server" });
});

app.post("/run-membership-fix", async (_req: Request, res: Response): Promise<void> => {
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-membership-fix`);
  try {
    const result = await runMembershipTask();
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: `Server error: ${msg}` });
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`\n🚀 Active Membership Server on port ${PORT}`);
  console.log(`   POST /run-membership-fix  ← n8n trigger`);
  console.log(`   GET  /health              ← Render health check\n`);
});
