# Implementation Plan: Staff Categories, Dynamic Category Form Fields & 4-Portal Access Control

Integrate default Teacher and Management categories into the customizable Staff Categories system, enable dynamic field rendering in staff forms based on the selected category's configuration, and implement a dedicated 4-portal access control and visibility section for staff accounts.

---

## 1. Objectives & Scope

1. **Default Teacher & Management in Staff Categories**:
   - Include **Teacher** and **Management** in the Staff Categories manager alongside any custom categories.
   - Allow admins to click **Edit** on Teacher or Management to customize which input fields are active/required, or add custom fields.
2. **Dynamic Staff Form Inputs (Add & Edit Forms)**:
   - When an admin selects a Category from the **Type** dropdown, the input fields in the staff form will dynamically reconfigure in real time to show only the fields configured for that category.
   - Support core fields (Name, Role/Subject, Photo, Phone, Login Email, Login Password, MSR Number, Address) and custom fields.
3. **Dedicated 4-Portal Access & Visibility Section**:
   - Replace the simple checkbox row with a structured, professional **Status & Portal Access** panel at the bottom of both the Add Staff form and Edit Staff modal.
   - Provide clear toggles for:
     - **Account Status**: Active / Inactive
     - **Public Page Visibility**: Show / Hide on Public Website
     - **Portal 1: Admin Panel Access** (`canAccessAdmin`)
     - **Portal 2: Official / Teacher Dashboard Access** (`canAccessOfficial`)
     - **Portal 3: Fee Collection Portal Access** (`canCollect`)
     - **Portal 4: Result Management Access** (`canManageResults`)
   - Synchronize permissions across Firestore staff records and authentication sessions.

---

## 2. Proposed Changes

### A. Staff Categories Configuration (`scripts/pages/admin-page.js`)
- Update `getDirectoryCategories()` and initial category seeding to guarantee that `Teacher` and `Management` exist with their standard field sets (Name, Role, Photo, Phone, Email, Password, MSR Number, Address) by default.
- Enhance `openEditStaffCategory()` to support editing `Teacher` and `Management` identically to any other category, including field activation toggles, required toggles, and custom fields.
- Prevent accidental deletion of fundamental core categories (or allow reset to defaults), while permitting full customization of fields and public visibility.

### B. Dynamic Staff Form Rendering (`admin.html` & `scripts/pages/admin-page.js`)
- Convert the static staff input fields in `admin.html` (both in "Add New Staff" and "Edit Staff Modal") into dynamic containers:
  - Header / Type selector at top.
  - Dynamic fields container that automatically renders the exact active fields of the currently selected category.
  - Photo upload widget seamlessly initialized if photo is active for that category.
  - Password and collection validation synchronized with the selected category's fields.
- Listen to `change` event on `st-type` and `e-st-type` to re-render the dynamic input fields instantly without resetting already entered matching values.

### C. Dedicated Status & 4-Portal Access Control Section (`admin.html` & `scripts/pages/admin-page.js`)
- Design an attractive card section at the bottom of the form:
  - **Account Status & Visibility**:
    - `Active Staff Account` toggle switch with status badge.
    - `Show on Public Website` toggle switch with public directory badge.
  - **4-Portal Access Matrix (Grid of 4 Cards)**:
    1. **Admin Panel** (`canAccessAdmin`): Administrative dashboard and configuration.
    2. **Official Dashboard** (`canAccessOfficial`): Teacher attendance, duty classes, student data.
    3. **Fee Collection Panel** (`canCollect`): Receipt generation, cashier collections.
    4. **Result Management** (`canManageResults`): Mark entry, exam evaluation controls.
- Update staff payload creation in `add-staff-btn` and `edit-staff-update` to store all 4 access flags (`canAccessAdmin`, `canAccessOfficial`, `canCollect`, `canManageResults`) along with any custom field values.
- Update `syncStaffAccessRecord` so that all portal authentication checks (`admin.html`, `official.html`, `collection.html`, `result.html`) immediately recognize these permissions.

### D. List Display & Badges
- Update the staff cards rendered in `renderStaffList()` to display badge indicators for the 4 granted portal permissions (`Admin`, `Official`, `Collection`, `Results`).

---

## 3. Verification Plan

1. **Category Management Verification**:
   - Verify Teacher and Management appear in the Staff Categories bar.
   - Click Edit on Teacher/Management, toggle a field (e.g. MSR or Address), save, and verify settings persist.
2. **Dynamic Form Adjustment**:
   - In "Add New Staff", switch between categories and verify form fields dynamically show/hide according to category settings.
   - Open "Edit Staff" on an existing staff member and verify all configured fields populate properly with current values.
3. **Portal Access Permissions**:
   - Create and edit staff members with different combinations of the 4 portal permissions.
   - Verify data is saved correctly in Firestore and reflected in the staff list badges.
4. **Build & Lint Verification**:
   - Run `compile_applet` and verify no compilation or bundling errors.
