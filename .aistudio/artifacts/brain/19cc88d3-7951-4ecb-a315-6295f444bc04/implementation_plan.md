# Implementation Plan: Shared Fee Entry/Edit Modal & PDF Generation Update

## Overview
Currently, clicking unpaid fee items in the **Fee Status** and **Master Fee Ledger** tabs does not reliably trigger immediate in-place fee entry due to fragmented modal logic across separate files, and users need a unified experience to add new fees or edit existing payments directly without navigating to the Fee Entry tab.

This plan introduces a **shared utility function** (`openFeeEntryEditModal`) that handles both adding new fee payments and editing existing fee records in-place. It instantly updates the clicked cell in the DOM, writes to Firestore directly, maintains collection history, and formats PDF exports according to the updated specification:
1. **Paid with Receipt Number**: Display receipt number in PDF.
2. **Paid without Receipt Number**: Display `Paid` in PDF.
3. **Unpaid / Not Paid**: Display a clean blank space in PDF.

---

## User Clarification Confirmations
- **UI Update Strategy**: Instant cell update on save for instantaneous user feedback, followed by background synchronization to keep global state and listeners intact.
- **PDF Export Content**:
  - Show receipt number if available.
  - If payment is recorded without a receipt number, print `Paid`.
  - Leave unpaid cells blank (no clutter or unwanted text tags).

---

## Proposed Changes

### 1. Shared Modal Utility Module (`scripts/pages/collection/shared-fee-modal.js`)
Create a single, authoritative shared modal manager accessible globally and via module export:
- **`openFeeEntryEditModal(options)`**:
  - Options: `{ student, unit, month, itemKey, paymentId, existingPayment, targetCellElement, onUpdated }`
  - **Add Mode (Unpaid)**:
    - Pre-populates student details, class, guardian, admission number, target month/fee item, and default fee amount.
    - Computes next automatic receipt number.
    - Sets modal header to **"Record Fee Payment"** with a green/blue collection theme.
  - **Edit Mode (Paid)**:
    - Fetches/receives existing payment record.
    - Pre-populates existing payment date, amount, receipt number, payment mode, and collector.
    - Sets modal header to **"Edit Fee Payment"**.
- **Direct Firestore Persistence**:
  - Handles batch/document creation or update in Firestore collection `collections` / `fee_payments`.
  - Assigns correct academic year, timestamps, and active collector metadata.
  - Generates/updates history audit entries.
- **Instant Cell DOM Update**:
  - Immediately transforms the target `<td>` element's inner HTML from "Unpaid" to "Paid (R: <receiptNo>)" (or "Paid") with smooth highlight animation without waiting for a full page re-render.
  - Emits local state update event so `allPayments` and `ledgerPayments` stay in sync.

### 2. Integration into Fee Status Tab (`scripts/pages/collection-page.js`)
- Update `fee-table-container` click delegation:
  - Clicking an **Unpaid** cell (`[data-fee-action="pay-fee"]`) directly invokes `openFeeEntryEditModal`.
  - Clicking a **Paid** cell (`[data-fee-action="view-receipt"]`) offers immediate direct edit via the shared modal or receipt slip.
  - When editing from the Receipt Detail Modal (`receipt-view-edit-btn`), route directly to `openFeeEntryEditModal` with the existing payment pre-loaded.
- Update `downloadFeeStatusPdf`:
  - When building table rows:
    - If `payment` exists and has `receiptNo`: render `payment.receiptNo`.
    - If `payment` exists but has no `receiptNo`: render `Paid`.
    - If unpaid: render empty string `""` (blank space).

### 3. Integration into Master Fee Ledger Tab (`scripts/pages/collection/master-ledger-module.js`)
- Update `master-ledger-table-container` click delegation:
  - Clicking an **Unpaid** month cell (`[data-ledger-action="pay-fee"]`) directly invokes `openFeeEntryEditModal`.
  - Clicking a **Paid** month cell (`[data-ledger-action="view-receipt"]`) directly opens `openFeeEntryEditModal` in edit mode (or via receipt view modal).
- Update `exportLedgerPdf`:
  - For academic months:
    - If `st.isPaid` and `st.receipt`: render `${st.receipt}`.
    - If `st.isPaid` without receipt: render `Paid`.
    - If unpaid: render empty string `""`.
  - Clear any residual 'Unpaid' tags or background colors in PDF autoTable cell styling.

### 4. HTML Modal Refinement (`collection.html`)
- Unify `#master-ledger-pay-modal` into a shared, robust modal structure `#shared-fee-entry-modal` (or standardize `#master-ledger-pay-modal` to serve both contexts seamlessly).
- Ensure hidden inputs capture `paymentId`, `studentId`, `unitId`, `itemKey`, `month`, and `academicYear`.

---

## Verification Plan

### Automated / Syntax Checks
- Run JavaScript syntax validation via `node --check` on all modified script files:
  - `node --check scripts/pages/collection/shared-fee-modal.js`
  - `node --check scripts/pages/collection-page.js`
  - `node --check scripts/pages/collection/master-ledger-module.js`
- Run `compile_applet` to confirm the Vite build compiles cleanly with zero errors.

### Manual Verification Flows
1. **Fee Status Tab**:
   - Click an unpaid student fee cell: verify the modal opens with student name, month, default fee, and next receipt number.
   - Enter/change payment details and click Record: verify the cell instantly reflects "Paid" with the receipt number without page reload.
   - Click a paid cell: verify the modal opens in edit mode with existing date, amount, and receipt number. Modify and save: verify cell reflects updated values immediately.
2. **Master Fee Ledger Tab**:
   - Click an unpaid month cell: verify the modal opens with family group or student details.
   - Save payment: verify the month cell turns green "Paid" immediately.
3. **PDF Export**:
   - Download PDF in Fee Status: verify paid entries show receipt number (or "Paid" if no receipt) and unpaid cells are completely blank.
   - Download PDF in Master Fee Ledger: verify same clean display.
