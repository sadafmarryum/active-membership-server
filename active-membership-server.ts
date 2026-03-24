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

// =============================================================================
// DEBUG HELPER - Log all labels and inputs in the modal
// =============================================================================

async function debugModalContents(page: SPage): Promise<{ labels: string[]; inputs: string[]; allText: string }> {
  return page.evaluate((): { labels: string[]; inputs: string[]; allText: string } => {
    const labels: string[] = [];
    const inputs: string[] = [];
    let allText = "";

    function searchRoot(root: Document | ShadowRoot | Element, prefix: string): void {
      // Find all text that might be labels
      root.querySelectorAll("*").forEach(el => {
        const htmlEl = el as HTMLElement;
        // Check direct text content (not children)
        const directText = Array.from(htmlEl.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => (n.textContent || "").trim())
          .filter(t => t.length > 0)
          .join(" ");
        if (directText && directText.length < 50) {
          labels.push(prefix + " text: '" + directText + "' in <" + htmlEl.tagName.toLowerCase() + ">");
        }
      });

      // Find all labels
      root.querySelectorAll("label").forEach(l => {
        labels.push(prefix + " <label>: '" + (l.textContent || "").trim() + "' for=" + (l.getAttribute("for") || "none"));
      });

      // Find all inputs
      root.querySelectorAll("input").forEach(inp => {
        const i = inp as HTMLInputElement;
        const rect = i.getBoundingClientRect();
        inputs.push(prefix + " <input> id=" + (i.id || "none") + " name=" + (i.name || "none") + " type=" + (i.type || "text") + " value='" + (i.value || "") + "' visible=" + (rect.width > 0));
      });

      // Check for shadow roots
      root.querySelectorAll("*").forEach(el => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.shadowRoot) {
          labels.push(prefix + " [shadow root in <" + htmlEl.tagName.toLowerCase() + ">]");
          searchRoot(htmlEl.shadowRoot, prefix + "  >");
        }
      });
    }

    // Search main document
    const modals = document.querySelectorAll('.modal, [role="dialog"], sera-modal');
    modals.forEach((m, idx) => {
      labels.push("=== Modal " + idx + ": " + m.tagName + " ===");
      searchRoot(m, "  ");
      if ((m as HTMLElement).shadowRoot) {
        searchRoot((m as HTMLElement).shadowRoot!, "  shadow>");
      }
    });

    // Get all text for reference
    const sm = document.querySelector("sera-modal");
    if (sm && sm.shadowRoot) {
      allText = (sm.shadowRoot.textContent || "").substring(0, 3000);
    }

    return { labels, inputs, allText };
  });
}

// =============================================================================
// FIND DATE INPUT BY LABEL - searches recursively through shadow DOM
// =============================================================================

async function findDateInputByLabel(page: SPage, labelText: string): Promise<{ x: number; y: number; found: boolean; inputId: string; debug: string }> {
  return page.evaluate((searchLabel: string): { x: number; y: number; found: boolean; inputId: string; debug: string } => {
    const labelLower = searchLabel.toLowerCase().trim();
    let debug = "Searching for: " + searchLabel;

    function searchInRoot(root: Document | ShadowRoot | Element): HTMLInputElement | null {
      // Strategy 1: Look for text content matching label, then find nearby input
      const allElements = Array.from(root.querySelectorAll("*"));
      
      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        
        // Check if this element contains the label text directly
        const directText = Array.from(htmlEl.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => (n.textContent || "").trim().toLowerCase())
          .join(" ");
        
        const fullText = (htmlEl.textContent || "").toLowerCase().trim();
        
        // Match exact or close match
        const isMatch = directText === labelLower || 
                       directText.includes(labelLower) ||
                       fullText === labelLower ||
                       (labelLower === "next billing date" && (directText.includes("next billing") || fullText === "next billing date")) ||
                       (labelLower === "starts on" && (directText.includes("starts on") || directText.includes("start")));
        
        if (isMatch && directText.length < 30) {
          debug += " | Found text match in <" + htmlEl.tagName + ">: '" + directText + "'";
          
          // Look for input in parent's children (sibling approach)
          const parent = htmlEl.parentElement;
          if (parent) {
            // Check all siblings and their descendants
            const siblings = Array.from(parent.children);
            for (const sib of siblings) {
              if (sib !== htmlEl) {
                const inp = sib.querySelector("input") || (sib.tagName === "INPUT" ? sib as HTMLInputElement : null);
                if (inp) {
                  debug += " | Found sibling input";
                  return inp as HTMLInputElement;
                }
              }
            }
            
            // Check parent's parent
            const grandparent = parent.parentElement;
            if (grandparent) {
              const inp = grandparent.querySelector("input");
              if (inp && inp !== htmlEl) {
                debug += " | Found input in grandparent";
                return inp as HTMLInputElement;
              }
            }
          }
          
          // Look for input following this element in DOM order
          let next = htmlEl.nextElementSibling;
          while (next) {
            const inp = next.querySelector("input") || (next.tagName === "INPUT" ? next as HTMLInputElement : null);
            if (inp) {
              debug += " | Found input in next sibling";
              return inp as HTMLInputElement;
            }
            next = next.nextElementSibling;
          }
        }
      }

      // Strategy 2: Traditional label[for] lookup
      const labels = Array.from(root.querySelectorAll("label"));
      for (const lbl of labels) {
        const lblText = (lbl.textContent || "").toLowerCase().trim();
        if (lblText === labelLower || lblText.includes(labelLower.replace(" date", ""))) {
          const forId = lbl.getAttribute("for");
          if (forId) {
            const inp = root.querySelector("#" + forId) as HTMLInputElement;
            if (inp) {
              debug += " | Found via label[for]";
              return inp;
            }
          }
        }
      }

      // Strategy 3: Search in nested shadow roots
      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.shadowRoot) {
          const result = searchInRoot(htmlEl.shadowRoot);
          if (result) return result;
        }
      }

      return null;
    }

    // Search in sera-modal first (most likely location)
    const seraModal = document.querySelector("sera-modal");
    let input: HTMLInputElement | null = null;
    
    if (seraModal) {
      debug += " | sera-modal found";
      if (seraModal.shadowRoot) {
        debug += " | has shadowRoot";
        input = searchInRoot(seraModal.shadowRoot);
      }
      if (!input) {
        input = searchInRoot(seraModal);
      }
    }

    // Fallback: search in any modal dialog
    if (!input) {
      const modals = document.querySelectorAll('.modal.show, [role="dialog"], .modal-content');
      for (const modal of Array.from(modals)) {
        input = searchInRoot(modal);
        if (input) break;
      }
    }

    // Fallback: search entire document
    if (!input) {
      input = searchInRoot(document);
    }

    if (!input) {
      return { x: 0, y: 0, found: false, inputId: "", debug: debug + " | NOT FOUND" };
    }

    // Generate unique ID if needed
    if (!input.id) {
      input.id = "__date_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    }

    input.scrollIntoView({ block: "center" });
    const rect = input.getBoundingClientRect();
    
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      found: rect.width > 0,
      inputId: input.id,
      debug: debug + " | FOUND id=" + input.id + " at " + Math.round(rect.left) + "," + Math.round(rect.top)
    };
  }, labelText);
}

// =============================================================================
// TYPE DATE INTO INPUT - uses CDP for reliable text entry
// =============================================================================

async function typeDate(page: SPage, labelText: string, dateValue: string): Promise<string> {
  console.log("  Looking for '" + labelText + "' to set value: '" + dateValue + "'");

  const result = await findDateInputByLabel(page, labelText);
  console.log("  Find result: " + result.debug);

  if (!result.found) {
    // Debug: dump modal contents
    const debug = await debugModalContents(page);
    console.log("  DEBUG - All labels/text found:");
    debug.labels.forEach(l => console.log("    " + l));
    console.log("  DEBUG - All inputs found:");
    debug.inputs.forEach(i => console.log("    " + i));
    throw new Error("Input not found for label: " + labelText);
  }

  const { x, y, inputId } = result;

  // Click to focus the input
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(300);

  // Triple-click to select all existing text
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 3, modifiers: 0 });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 3, modifiers: 0 });
  await page.waitForTimeout(200);

  // Ctrl+A to ensure all is selected
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.waitForTimeout(100);

  // Type the new date value character by character
  await page.sendCDP("Input.insertText", { text: dateValue });
  await page.waitForTimeout(300);

  // Press Tab to move focus and trigger validation/change events
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await page.waitForTimeout(300);

  // Press Escape to close any date picker popup that might have opened
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.sendCDP("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.waitForTimeout(200);

  // Verify the value
  const finalValue = await page.evaluate((id: string): string => {
    // Try main document
    let el = document.getElementById(id) as HTMLInputElement | null;
    if (el) return el.value;
    
    // Try sera-modal shadow
    const sm = document.querySelector("sera-modal");
    if (sm && sm.shadowRoot) {
      el = sm.shadowRoot.getElementById(id) as HTMLInputElement | null;
      if (el) return el.value;
      
      // Try nested shadows
      sm.shadowRoot.querySelectorAll("*").forEach(child => {
        if (!el && (child as HTMLElement).shadowRoot) {
          el = (child as HTMLElement).shadowRoot!.getElementById(id) as HTMLInputElement | null;
        }
      });
      if (el) return el.value;
    }
    
    return "";
  }, inputId);

  console.log("  Final value: '" + finalValue + "'");
  return finalValue;
}

// =============================================================================
// CLICK SAVE & COMPLETE BUTTON
// =============================================================================

async function clickSave(page: SPage): Promise<string> {
  const coords = await page.evaluate((): { x: number; y: number; found: boolean; debug: string } => {
    function findButton(root: Document | ShadowRoot | Element): HTMLElement | null {
      // Look for button with "Save & Complete" text
      const buttons = Array.from(root.querySelectorAll("button"));
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim().toLowerCase();
        if (text.includes("save") && text.includes("complete")) {
          return btn;
        }
      }

      // Look for any element with "Save & Complete" text
      const allElements = Array.from(root.querySelectorAll("*"));
      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        const text = (htmlEl.textContent || "").trim();
        if (text === "Save & Complete" || text === "Save &amp; Complete") {
          return htmlEl;
        }
      }

      // Look for span with specific Vue attribute
      const spans = Array.from(root.querySelectorAll("span[data-v-c7226b75]"));
      for (const span of spans) {
        if ((span.textContent || "").toLowerCase().includes("save")) {
          return span as HTMLElement;
        }
      }

      // Search nested shadow roots
      for (const el of allElements) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.shadowRoot) {
          const result = findButton(htmlEl.shadowRoot);
          if (result) return result;
        }
      }

      return null;
    }

    let btn: HTMLElement | null = null;

    // Search sera-modal first
    const seraModal = document.querySelector("sera-modal");
    if (seraModal) {
      if (seraModal.shadowRoot) {
        btn = findButton(seraModal.shadowRoot);
      }
      if (!btn) {
        btn = findButton(seraModal);
      }
    }

    // Search other modals
    if (!btn) {
      const modals = document.querySelectorAll('.modal.show, [role="dialog"]');
      for (const modal of Array.from(modals)) {
        btn = findButton(modal);
        if (btn) break;
      }
    }

    // Search document
    if (!btn) {
      btn = findButton(document);
    }

    if (!btn) {
      return { x: 0, y: 0, found: false, debug: "Save & Complete button not found" };
    }

    btn.scrollIntoView({ block: "center" });
    const rect = btn.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      found: rect.width > 0,
      debug: "Found <" + btn.tagName + "> '" + (btn.textContent || "").trim().substring(0, 30) + "' at " + Math.round(rect.left) + "," + Math.round(rect.top)
    };
  });

  console.log("  Save button: " + coords.debug);

  if (!coords.found) {
    throw new Error("Save & Complete not found");
  }

  const { x, y } = coords;
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.waitForTimeout(50);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);
  await page.sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  await page.waitForTimeout(100);

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
    await page.goto("https://misterquik.sera.tech/memberships");
    await page.waitForTimeout(3000);

    const rows = await waitForRows(page, 15000);
    if (rows.length === 0) {
      console.log("No memberships found");
      return { success: true, message: "No memberships found", processedCount: 0, failedCount: 0, processed: [], failed: [], elapsedMinutes: 0, sessionUrl };
    }

    console.log("[3] Found " + rows.length + " memberships");
    
    for (const r of rows) {
      console.log("\n========================================");
      console.log("Processing: " + r.customer + " | " + r.program + " | " + r.soldOn);
      console.log("========================================");
      
      try {
        // Open the modal
        const clickRes = await openMembershipModal(stagehand, page, r.customer, r.soldOn, r.program);
        console.log("  Modal click: " + clickRes);
        
        if (clickRes.startsWith("NOT FOUND")) {
          failed.push({ ...r, message: clickRes });
          continue;
        }
        
        const modalOpened = await waitForModal(page, 8000);
        if (!modalOpened) { 
          failed.push({ ...r, message: "Modal did not open" }); 
          continue; 
        }
        console.log("  Modal opened");

        // Wait a bit for modal to fully render
        await page.waitForTimeout(500);

        // Determine variant and calculate dates
        const variant = getModalVariant(r.program);
        const secondDate = calcSecondDate(r.soldOnShort, r.program);
        console.log("  Variant: " + variant + " | Starts: " + r.soldOnShort + " | Second: " + secondDate);

        // Fill "Starts On" field
        let startsOnValue = "";
        try {
          startsOnValue = await typeDate(page, "Starts On", r.soldOnShort);
        } catch (e) {
          console.log("  Starts On failed, trying alternatives...");
          try {
            startsOnValue = await typeDate(page, "Start Date", r.soldOnShort);
          } catch (e2) {
            throw new Error("Could not find Starts On field");
          }
        }

        // Fill second date field based on variant
        let secondValue = "";
        const secondLabels = variant === "ends-on"
          ? ["Ends On", "End Date", "Expiration Date"]
          : ["Next Billing Date", "Next Billing", "Billing Date", "Renewal Date"];
        
        for (const label of secondLabels) {
          try {
            secondValue = await typeDate(page, label, secondDate);
            console.log("  Second date set using: " + label);
            break;
          } catch (e) {
            console.log("  '" + label + "' not found, trying next...");
          }
        }

        if (!secondValue) {
          throw new Error("Could not find second date field. Tried: " + secondLabels.join(", "));
        }

        // Click Save & Complete
        console.log("  Clicking Save & Complete...");
        await clickSave(page);
        
        // Wait for modal to close
        const closed = await waitForModalClose(page, 10000);
        if (!closed) {
          console.log("  Warning: Modal may not have closed properly");
        }

        // Wait for row to disappear (up to 3 minutes)
        console.log("  Waiting for row to disappear...");
        let rowRemoved = false;
        const waitStart = Date.now();
        
        while (Date.now() - waitStart < 180000) {
          const stillThere = await page.evaluate(
            (args: { soldOn: string; customer: string }): boolean => {
              const rows = document.querySelectorAll("table tbody tr");
              return Array.from(rows).some(row => {
                const cells = row.querySelectorAll("td");
                const s = (cells[0]?.textContent || "").trim();
                const c = (cells[3]?.textContent || "").trim();
                return s === args.soldOn && c === args.customer;
              });
            },
            { soldOn: r.soldOn, customer: r.customer }
          );

          if (!stillThere) {
            rowRemoved = true;
            break;
          }
          
          console.log("  Row still present, waiting 5s...");
          await page.waitForTimeout(5000);
        }

        if (!rowRemoved) {
          failed.push({ ...r, message: "Row not removed after 3 minutes" });
          console.log("  FAILED: Row still in table");
          continue;
        }

        console.log("  SUCCESS: Row removed");
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

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log("  FAILED: " + errMsg);
        failed.push({ ...r, message: errMsg });
        
        // Try to close modal before moving to next row
        try {
          await page.evaluate(() => {
            const closeBtn = document.querySelector<HTMLElement>('.modal .close, [aria-label="Close"], .btn-close, button.close');
            if (closeBtn) closeBtn.click();
          });
          await page.waitForTimeout(500);
        } catch (e) {
          // Ignore
        }
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
      sessionUrl
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
      sessionUrl
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
