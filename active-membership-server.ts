// active-membership-server.ts
// Express server + Stagehand v3 browser automation
//
// APPROACH:
//  - Navigation + modal open: pure CDP (fast, reliable)
//  - Date fields: CDP keyboard typing (ctrl+a → type → tab)
//  - Save & Complete: stagehand.act() with a very precise instruction
//    (act() works fine when the modal IS open and rendered — previous failures
//     were because the button wasn't visible yet, not because act() is broken)
//  - Success verification: wait for modal to close after save

import { Stagehand, V3 } from "@browserbasehq/stagehand";
import express, { Request, Response } from "express";

type SPage        = NonNullable<ReturnType<V3["context"]["activePage"]>>;
type ModalVariant = "ends-on" | "next-billing" | "unknown";

interface MembershipRow {
  soldOn: string; invoice: string; job: string;
  customer: string; program: string; rowIndex: number;
  linkHref: string; // href of the <a> that opens the modal
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
// HELPERS
// =============================================================================

function getModalVariant(p: string): ModalVariant {
  const n = p.toLowerCase();
  if (n.includes("10-year") || n.includes("10 year")) return "ends-on";
  if (n.includes("5-year")  || n.includes("5 year"))  return "ends-on";
  return "next-billing";
}

function calcSecondDate(soldOn: string, program: string): string {
  const [m, d, y] = soldOn.split("/");
  if (!m || !d || !y) return soldOn;
  const n = program.toLowerCase();
  let add = 1;
  if (n.includes("10-year") || n.includes("10 year")) add = 10;
  else if (n.includes("5-year") || n.includes("5 year")) add = 5;
  return `${m}/${d}/${parseInt(y, 10) + add}`;
}

async function waitForRows(page: SPage, ms = 10000): Promise<MembershipRow[]> {
  const t = Date.now() + ms;
  while (Date.now() < t) {
    const rows: MembershipRow[] = await page.evaluate((): MembershipRow[] => {
      const out: MembershipRow[] = [];
      document.querySelectorAll("table tbody tr").forEach((r, i) => {
        const c = r.querySelectorAll("td");
        if (c.length < 5) return;
        const soldOn = c[0]?.textContent?.trim() ?? "";
        if (!soldOn.match(/\d{2}\/\d{2}\/\d{4}/)) return;
        // Capture the href from whichever cell contains the program link
        // (typically cells[4] which is the program name column)
        const programCell = c[4];
        const programLink = programCell?.querySelector("a");
        // Also check all cells for any link that opens a modal (has data attrs or specific href)
        let linkHref = programLink?.getAttribute("href") ?? "";
        // If no link in program cell, check invoice/job cells
        if (!linkHref) {
          for (let ci = 0; ci < c.length; ci++) {
            const a = c[ci]?.querySelector("a");
            if (a) { linkHref = a.getAttribute("href") ?? ""; if (linkHref) break; }
          }
        }
        out.push({
          soldOn, invoice: c[1]?.textContent?.trim() ?? "",
          job: c[2]?.textContent?.trim() ?? "",
          customer: c[3]?.textContent?.trim() ?? "",
          program: c[4]?.textContent?.trim() ?? "",
          rowIndex: i, linkHref,
        });
      });
      return out;
    });
    if (rows.length > 0) return rows;
    await page.waitForTimeout(500);
  }
  return [];
}

async function waitForModal(page: SPage, ms = 7000): Promise<boolean> {
  const t = Date.now() + ms;
  while (Date.now() < t) {
    const open: boolean = await page.evaluate((): boolean => {
      if (document.querySelector<HTMLElement>('.modal.show,[role="dialog"]')?.offsetParent) return true;
      const sm = document.querySelector("sera-modal");
      if (sm?.shadowRoot && sm.shadowRoot.childElementCount > 0) return true;
      return !!document.querySelector<HTMLElement>(".modal-title,h4,h5")
        ?.textContent?.includes("Edit Memberships");
    });
    if (open) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForModalClose(page: SPage, ms = 10000): Promise<boolean> {
  const t = Date.now() + ms;
  while (Date.now() < t) {
    const open: boolean = await page.evaluate((): boolean => {
      if (document.querySelector<HTMLElement>('.modal.show,[role="dialog"]')?.offsetParent) return true;
      const sm = document.querySelector("sera-modal");
      return !!(sm?.shadowRoot && sm.shadowRoot.childElementCount > 0);
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
    if (sm?.shadowRoot) {
      const st = (sm.shadowRoot.textContent ?? "").toLowerCase();
      if (st.includes("ends on")) return "ends-on";
      if (st.includes("next billing")) return "next-billing";
    }
    return "unknown";
  });
}

/**
 * Type a date into a SERA date input.
 * Strategy:
 *  1. Find input element by its label text (searches main DOM + sera-modal shadow root)
 *  2. Click the field 3× to select-all
 *  3. Type the date string (MM/DD/YYYY) using CDP Input.insertText
 *  4. Tab out to commit the value
 */
async function typeDate(page: SPage, labelText: string, dateValue: string): Promise<void> {
  // Find the input and stamp a stable ID on it
  const inputId: string = await page.evaluate(
    (args: { label: string; stamp: string }): string => {
      const find = (root: Document | ShadowRoot): HTMLInputElement | null => {
        for (const lbl of Array.from(root.querySelectorAll<HTMLLabelElement>("label"))) {
          if (lbl.textContent?.trim().toLowerCase() !== args.label.toLowerCase()) continue;
          const forId = lbl.getAttribute("for");
          if (forId) {
            const el = (root instanceof Document ? root : document).getElementById(forId);
            if (el) return el as HTMLInputElement;
          }
          // Walk siblings
          let sib = lbl.nextElementSibling;
          while (sib) {
            if (sib.tagName === "INPUT") return sib as HTMLInputElement;
            const inp = sib.querySelector<HTMLInputElement>("input");
            if (inp) return inp;
            sib = sib.nextElementSibling;
          }
        }
        return null;
      };
      let el = find(document);
      if (!el) {
        const sm = document.querySelector("sera-modal");
        if (sm?.shadowRoot) el = find(sm.shadowRoot);
      }
      if (!el) return "";
      if (!el.id) el.id = args.stamp;
      return el.id;
    },
    { label: labelText, stamp: `__d_${labelText.replace(/\W/g, "")}_${Date.now()}` }
  );

  if (!inputId) throw new Error(`Label "${labelText}" not found`);

  const loc = page.locator(`#${inputId}`).first();

  // Click 3× to select existing content, then type over it
  await loc.click({ clickCount: 3 });
  await page.waitForTimeout(200);

  // Select all via Ctrl+A
  await page.sendCDP("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA",
    modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await page.sendCDP("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA",
    modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await page.waitForTimeout(100);

  // Type the date
  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(200);

  // Tab to commit
  await page.sendCDP("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
  });
  await page.sendCDP("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
  });
  await page.waitForTimeout(400);

  // Verify the value was accepted
  const actual: string = await page.evaluate(
    (id: string): string => (document.getElementById(id) as HTMLInputElement)?.value ?? "",
    inputId
  );
  console.log(`  ℹ️  "${labelText}" field value after typing: "${actual}"`);
}

/**
 * Click Save & Complete.
 *
 * We try three strategies in order:
 *  1. stagehand.act() — works if the button is in Stagehand's DOM snapshot
 *  2. CDP mouse click via getBoundingClientRect coordinates (works on shadow DOM)
 *  3. JS .click() composed event as last resort
 */
async function clickSave(stagehand: V3, page: SPage): Promise<void> {
  // Strategy 1: stagehand.act() — let the AI find it
  try {
    await stagehand.act(
      'Click the blue "Save & Complete" button at the bottom right of the modal dialog that is currently open on screen'
    );
    console.log("  ℹ️  Save clicked via stagehand.act()");
    return;
  } catch (e: unknown) {
    console.log(`  ⚠️  act() failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }

  // Strategy 2: CDP mouse click using getBoundingClientRect
  // getBoundingClientRect works across shadow roots (it returns viewport coords)
  const coords: { x: number; y: number; ok: boolean } = await page.evaluate((): { x: number; y: number; ok: boolean } => {
    const findBtn = (root: Document | ShadowRoot): HTMLElement | null => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("button,input[type=submit],[role=button]"))) {
        const t = el.textContent?.trim().toLowerCase() ?? "";
        if (t === "save & complete" || t === "save and complete") return el;
      }
      return null;
    };

    let btn = findBtn(document);
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

    if (!btn) return { x: 0, y: 0, ok: false };

    btn.scrollIntoView({ block: "center", inline: "center" });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 0 };
  });

  if (coords.ok) {
    const { x, y } = coords;
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved",   x, y, button: "none" });
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await page.waitForTimeout(100);
    await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log(`  ℹ️  Save clicked via CDP mouse at (${x}, ${y})`);
    return;
  }

  // Strategy 3: composed JS click
  const jsClicked: boolean = await page.evaluate((): boolean => {
    const findBtn = (root: Document | ShadowRoot): HTMLElement | null => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("button,[role=button]"))) {
        const t = el.textContent?.trim().toLowerCase() ?? "";
        if (t === "save & complete" || t === "save and complete") return el;
      }
      return null;
    };
    let btn = findBtn(document);
    const sm = document.querySelector("sera-modal");
    if (!btn && sm?.shadowRoot) btn = findBtn(sm.shadowRoot);
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    return true;
  });

  if (!jsClicked) throw new Error("Save & Complete button not found anywhere");
  console.log("  ℹ️  Save clicked via composed MouseEvent");
}

// =============================================================================
// MAIN
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
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page: SPage = stagehand.context.activePage()!;

    // ── Login ────────────────────────────────────────────────────────
    console.log("\n[1] → Login");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    if (page.url().includes("/login")) {
      await page.locator('input[type="email"]').first().fill(
        process.env.SERA_EMAIL ?? "mcc@stratablue.com"
      );
      await page.locator('input[type="password"]').first().fill(
        process.env.SERA_PASSWORD ?? ""
      );
      await page.waitForTimeout(400);

      const clicked: boolean = await page.evaluate((): boolean => {
        const btn = Array.from(document.querySelectorAll<HTMLElement>('button,input[type=submit]'))
          .find(el =>
            ["sign in","login","log in"].some(k =>
              el.textContent?.toLowerCase().trim() === k ||
              (el as HTMLInputElement).value?.toLowerCase() === k
            ) && el.offsetParent !== null
          );
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) await page.locator('button[type=submit]').first().click();

      let ok = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes("/login")) { ok = true; break; }
      }
      if (!ok) throw new Error("Login failed");
      console.log("    ✅ Logged in");
    } else {
      console.log("    ✅ Already logged in");
    }

    // ── Load memberships & read rows ─────────────────────────────────
    console.log("\n[2] → /memberships");
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const allRows = await waitForRows(page);
    console.log(`    ℹ️  ${allRows.length} row(s)`);
    allRows.forEach((r, i) =>
      console.log(`      [${i+1}] ${r.soldOn} | ${r.customer} | ${r.program}`)
    );

    if (allRows.length === 0) {
      return {
        success: true, message: "No rows found.",
        processedCount: 0, failedCount: 0, processed: [], failed: [],
        elapsedMinutes: parseFloat(((Date.now()-t0)/60000).toFixed(2)), sessionUrl,
      };
    }

    // ── Process each row ─────────────────────────────────────────────
    for (let i = 0; i < allRows.length; i++) {
      const row    = allRows[i];
      const date2  = calcSecondDate(row.soldOn, row.program);
      const expVar = getModalVariant(row.program);

      console.log(`\n[3.${i+1}] ${row.customer} | "${row.program}"`);
      console.log(`  Sold On: ${row.soldOn}  →  ${expVar === "ends-on" ? "Ends On" : "Next Billing"}: ${date2}`);

      await page.goto("https://misterquik.sera.tech/memberships");
      await page.waitForTimeout(2000);

      if ((await waitForRows(page, 8000)).length === 0) {
        failed.push({ ...row, message: "Table empty after reload" }); continue;
      }

      // Open the Edit Memberships modal for this row.
      // Strategy 1: stagehand.act() — AI finds and clicks the program name link
      let linkClicked = false;
      try {
        await stagehand.act(
          `Click the program link "${row.program}" for customer "${row.customer}" ` +
          `in the memberships table to open the Edit Memberships modal`
        );
        linkClicked = true;
        console.log("  ℹ️  Modal opened via stagehand.act()");
      } catch (e: unknown) {
        console.log(`  ⚠️  act() failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }

      // Strategy 2: if act() failed or returned empty elementId, click by row position
      if (!linkClicked) {
        linkClicked = await page.evaluate(
          (args: { soldOn: string; customer: string; program: string; rowIndex: number; linkHref: string }): boolean => {
            const allRows = Array.from(document.querySelectorAll("table tbody tr"));

            // Find the matching row
            const matchRow = allRows.find(r => {
              const texts = Array.from(r.querySelectorAll("td")).map(c => c.textContent?.trim() ?? "");
              return texts.some(t => t === args.soldOn)
                  && texts.some(t => t === args.customer);
            }) ?? allRows[args.rowIndex];

            if (!matchRow) return false;

            // Try every <a> in the row — click each until one triggers a modal
            // The program cell link is usually the last or specific column
            const links = Array.from(matchRow.querySelectorAll<HTMLAnchorElement>("a"))
              .filter(a => (a as HTMLElement).offsetParent !== null);

            // Prefer links that look like modal triggers (no full URL, or href="#" or data attrs)
            const modalLink = links.find(a => {
              const href = a.getAttribute("href") ?? "";
              return href === "#" || href === "" || href.startsWith("javascript") || a.hasAttribute("data-");
            }) ?? links[links.length - 1] ?? links[0]; // last link is often the program name

            if (modalLink) { modalLink.click(); return true; }

            // No links — click the row itself
            (matchRow as HTMLElement).click();
            return true;
          },
          { soldOn: row.soldOn, customer: row.customer, program: row.program,
            rowIndex: row.rowIndex, linkHref: row.linkHref }
        );
      }

      if (!linkClicked) {
        failed.push({ ...row, message: "Program link not found" }); continue;
      }

      const modalOpen = await waitForModal(page, 7000);
      if (!modalOpen) {
        failed.push({ ...row, message: "Modal did not open" }); continue;
      }
      console.log("  ✅ Modal open");
      await page.waitForTimeout(800);

      const variant  = await detectVariant(page);
      const useVar   = variant !== "unknown" ? variant : expVar;
      const field2   = useVar === "ends-on" ? "Ends On" : "Next Billing Date";
      console.log(`  ℹ️  Field: "${field2}"`);

      // Set Starts On
      let startsOk = false;
      for (let a = 1; a <= 3; a++) {
        try {
          await typeDate(page, "Starts On", row.soldOn);
          console.log(`  ✅ Starts On (attempt ${a})`);
          startsOk = true; break;
        } catch (e: unknown) {
          console.log(`  ⚠️  Starts On attempt ${a}: ${e instanceof Error ? e.message : e}`);
          await page.waitForTimeout(500);
        }
      }
      if (!startsOk) console.log("  ⚠️  Starts On not confirmed");

      // Set second date
      try {
        await typeDate(page, field2, date2);
        console.log(`  ✅ "${field2}"`);
      } catch (e: unknown) {
        console.log(`  ⚠️  "${field2}": ${e instanceof Error ? e.message : e}`);
      }

      await page.waitForTimeout(600);

      // Save & Complete
      console.log("  → Save & Complete …");
      try {
        await clickSave(stagehand, page);
        await page.waitForTimeout(500);

        const closed = await waitForModalClose(page, 10000);
        if (!closed) {
          failed.push({ ...row, message: "Modal did not close after save — save may have failed" });
          console.log("  ❌ Modal still open after 10 s");
          continue;
        }

        console.log("  ✅ Saved (modal closed)");
        processed.push({
          customer: row.customer, job: row.job, program: row.program,
          soldOn: row.soldOn, startsOn: row.soldOn,
          secondDateField: field2, secondDateValue: date2,
          message: `${row.customer} | Job #${row.job} | ${row.program} | Starts On: ${row.soldOn} | ${field2}: ${date2}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ ...row, message: `Save failed: ${msg}` });
        console.log(`  ❌ ${msg}`);
      }
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Fatal: ${msg}`);
    failed.push({ message: `Fatal: ${msg}` });
  } finally {
    await stagehand.close();
    console.log("🔒 Closed");
  }

  const elapsed = ((Date.now()-t0)/60000).toFixed(2);
  const success = failed.length === 0;

  let message: string;
  if (!processed.length && !failed.length) {
    message = "Nothing to process.";
  } else {
    const lines: string[] = [];
    if (processed.length) {
      lines.push(`✅ Processed ${processed.length} membership(s):`);
      processed.forEach(p => lines.push(`   - ${p.message}`));
    }
    if (failed.length) {
      lines.push(`❌ Failed ${failed.length} membership(s):`);
      failed.forEach(f => lines.push(`   - ${f.customer ?? "unknown"} | ${f.message}`));
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
// EXPRESS
// =============================================================================

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok", service: "active-membership-server" });
});

app.post("/run-membership-fix", async (_req: Request, res: Response): Promise<void> => {
  console.log(`\n📥 [${new Date().toISOString()}] POST /run-membership-fix`);
  try {
    res.json(await runMembershipTask());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Server error: ${msg}` });
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT} | POST /run-membership-fix | GET /health`);
});
