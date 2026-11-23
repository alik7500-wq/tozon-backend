# Resettlement-linked sale: implementation contract

Status: DESIGN / NOT IMPLEMENTED. No production data mutation authorized by this document.

## Business invariants
- One resettlement case may link multiple apartments/deals for one buyer.
- Case #1: unit 92 / deal 27 (SIGNED), unit 91 / deal 42 (RESERVED). Areas 81.80 + 43.22 = 125.02 m²; free 90.00; payable 35.02 m²; case payable 1,400,800 USD cents at provisional 400 USD/m².
- Existing deals have face values 3,272,000 and 3,025,400 cents, totaling 6,297,400 cents. These MUST NOT be added to the resettlement case payable as if separate obligations.
- Existing active payments deal 27: 682,000 cents NON_CASH_BARTER (business meaning: repair compensation credit), 60,000 cents CASH, 102,052 cents CASH; no payments deal 42. Keep these untouched.
- Do not silently rewrite signed deal #27, its payment schedule, price, receipts, cash journals or history.
- Do not turn RESERVED unit 91 into SOLD until a legitimate sale contract is executed through existing workflow.
- Existing signed and reserved deal amounts are not an approved allocation of the resettlement case payable.

## Required workflow before enabling linked sale
1. ADMIN/DIRECTOR opens an APPROVED case and initiates 'Оформить продажу в рамках переселения' for a linked RESERVED deal.
2. Present explicit financial reconciliation: case payable, all linked contract amounts, actual cash receipts, non-cash credits, and provisional balance. Distinguish contractual debt from analytical case balance.
3. Require approved allocation of the 1,400,800 cents across the linked deals (integer cents, nonnegative, sum exactly case payable), and written amendment/reconciliation of already signed deal #27 before any replacement of its contractual amount. No default allocation inferred from square metres, unit order or existing deal face prices.
4. Maintain an immutable approval/audit record with actor, timestamp, prior and new allocation, and reference to the signed supporting document.
5. Use transaction-safe idempotent backend operation; recheck case APPROVED, unit RESERVED, same buyer, project, allocation sum, no concurrent sale, and permissions ADMIN/DIRECTOR. Failure must roll back all operations.
6. Invoke existing contract signing workflow to update deal/unit state, not a direct status SQL update. Do not create duplicate payment records, schedule rows or sale counts.
7. Reports: count only signed deals as sales; show free/compensated area separately, not as sold revenue; total recognized resettlement consideration is bounded by the approved allocation and applicable accounting policy.
8. For case #1, display analytical balance 556,748 cents only if all relevant USD payments/credits are verified and properly attributed. Do not claim it is legally collectible until contract amendments and credit allocation are approved.

## Acceptance tests
- Existing signed deal 27 remains unchanged.
- Reserved deal 42 stays reserved until signed.
- Case 1 remains approved and associated with both apartments.
- Approved allocations cannot sum to any amount other than 1,400,800 cents.
- Duplicate requests cannot create two sales or double receipts.
- Unauthorized user cannot approve allocation or sign.
- Existing payment #96 is displayed as non-cash credit, never cash.
- A failed signing leaves deal, unit, schedules, reports and allocations consistent.
- Reports do not count RESERVED units as sold.

## Delivery gates
Implement and test on TEST first, review against actual contract template and sales-signing API, back up production before any additive migration, then deploy separately with feature flag OFF until approved financial allocation is entered.
